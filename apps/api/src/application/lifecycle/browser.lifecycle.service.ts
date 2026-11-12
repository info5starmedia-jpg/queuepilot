import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import path from "node:path";
import {
  DomainError,
  ErrorCodes,
  TempProxyInputSchema,
  type AttestationResult,
  type BrowserRun,
  type BrowserTab,
  type IdentityDrift,
  type LifecycleEvent,
  type OpenTabInput,
  type Profile,
  type SessionPartition,
  type TempProxyInput,
} from "@queuepilot/contracts";
import { isProcessAlive } from "../../infrastructure/process-inventory.js";
import { compareFingerprint } from "../profiles/fingerprint-attestation.js";
import type {
  ProfileRepository,
  FingerprintIdentityRepository,
} from "../profiles/profile.repository.js";
import type { ProxyService } from "../proxies/proxy.service.js";
import type { BrowserRunRepository } from "./browser-run.repository.js";
import { ProfileOperationMutex } from "./profile-operation.mutex.js";
import { proxyUrl } from "@queuepilot/contracts";
import type {
  BrowserRuntime,
  BrowserSession,
} from "../runtime/browser-runtime.js";
import type { LaunchIdentityService } from "./launch-identity.service.js";
import { TabRegistry } from "../tabs/tab-registry.js";

export interface StartOptions {
  /**
   * One-shot proxy for this run only. Overrides the profile's attached proxy
   * for the launch; never persisted — the profile row is untouched and its own
   * proxy applies again at the next start. Validated against
   * TempProxyInputSchema before anything is written.
   */
  tempProxy?: TempProxyInput | null;
}

/**
 * BrowserLifecycleService — the deterministic core of QueuePilot.
 *
 * Invariants it enforces:
 *  1. At most one occupying run per profile, guarded twice: in-process by the
 *     ProfileOperationMutex, durably by the partial unique index in
 *     browser_runs (a crashed API mid-launch cannot leave a profile stuck or
 *     doubly launched after restart).
 *  2. A run row exists BEFORE the engine spawns, so recovery can always see
 *     what the API intended.
 *  3. Engine exit (clean or crash) always transitions the run row and the
 *     profile status; nothing about run state lives only in memory.
 *  4. Stop is idempotent: stopping a stopped/crashed profile is a no-op
 *     success, because automation retries are a fact of life.
 */
export class BrowserLifecycleService {
  private readonly sessions = new Map<string, BrowserSession>();
  readonly events = new EventEmitter();
  private readonly mutex = new ProfileOperationMutex();
  private readonly tabRegistry = new TabRegistry();
  /**
   * Host-wide concurrent-profile cap (AliasMode's lifecycle admission slots).
   * 0 = unlimited (default; this machine is the operator's own). Set
   * QUEUEPILOT_MAX_CONCURRENT_PROFILES to bound RAM/CPU: each engine is a full
   * Chromium, and a queue of launches is cheaper than a swap storm.
   */
  private readonly maxConcurrent: number = (() => {
    const n = Number(process.env.QUEUEPILOT_MAX_CONCURRENT_PROFILES ?? 0);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  })();

  constructor(
    private readonly profiles: ProfileRepository,
    private readonly identities: FingerprintIdentityRepository,
    private readonly proxyService: ProxyService,
    private readonly runs: BrowserRunRepository,
    private readonly runtime: BrowserRuntime,
    private readonly dataDir: string,
    private readonly snapshots?: LaunchIdentityService,
  ) {
    this.events.setMaxListeners(0);
  }

  async start(profileId: string, opts: StartOptions = {}): Promise<BrowserRun> {
    return this.mutex.runExclusive(profileId, async () => {
      const profile = this.requireProfile(profileId);
      if (this.runs.occupyingForProfile(profileId)) {
        throw new DomainError(
          ErrorCodes.PROFILE_ALREADY_RUNNING,
          `profile ${profileId} already has an active browser run`,
        );
      }

      const identity = profile.identityId
        ? this.identities.get(profile.identityId)
        : null;
      // A temp proxy wins over the profile's attached proxy for THIS launch
      // only. Nothing is persisted: the profile row keeps its proxyId, and the
      // launch snapshot records proxySource so drift can explain itself.
      const tempProxy = opts.tempProxy
        ? TempProxyInputSchema.parse(opts.tempProxy)
        : null;
      const attached = tempProxy
        ? null
        : profile.proxyId
          ? this.proxyService.getStored(profile.proxyId)
          : null;
      const launchProxyUrl = tempProxy
        ? proxyUrl({
            type: tempProxy.type,
            host: tempProxy.host,
            port: tempProxy.port,
            username: tempProxy.username ?? null,
            password: tempProxy.password ?? null,
          })
        : attached
          ? proxyUrl(attached)
          : null;
      const proxySource = tempProxy
        ? ("temporary" as const)
        : attached
          ? ("profile" as const)
          : ("none" as const);

      const run: BrowserRun = {
        id: randomUUID(),
        profileId,
        status: "launching",
        pid: null,
        debugPort: null,
        wsEndpoint: null,
        startedAt: new Date().toISOString(),
        stoppedAt: null,
        lastError: null,
      };
      // Written before spawn — see invariant 2. The admission slot is the
      // host-wide guard: count+insert atomically, so a second launch over
      // the cap is refused BEFORE any engine spawns, not after.
      if (this.maxConcurrent > 0) {
        const { admitted, occupying } = this.runs.admit(run, this.maxConcurrent);
        if (!admitted) {
          throw new DomainError(
            ErrorCodes.HOST_AT_CAPACITY,
            `host at capacity: ${occupying}/${this.maxConcurrent} profiles running; stop one and retry`,
          );
        }
      } else {
        this.runs.create(run);
      }
      this.markProfile(profile, "running");

      let session: BrowserSession;
      try {
        session = await this.runtime.launch({
          profile,
          identity,
          proxyUrl: launchProxyUrl,
          profileDataDir: path.join(this.dataDir, "profiles", profile.id),
        });
      } catch (err) {
        this.failRun(run, profile, err);
        throw err instanceof DomainError
          ? err
          : new DomainError(
              ErrorCodes.ENGINE_LAUNCH_FAILED,
              err instanceof Error ? err.message : String(err),
            );
      }

      const live: BrowserRun = {
        ...run,
        status: "running",
        pid: session.pid,
        debugPort: session.debugPort,
        wsEndpoint: session.wsEndpoint,
      };
      this.runs.update(live);
      this.sessions.set(profileId, session);
      // Identity of record: snapshot exactly what the engine launched with.
      // Later edits to the profile drift against this and apply at next start.
      this.snapshots?.capture({
        runId: live.id,
        profile,
        identity,
        proxyId: tempProxy ? null : (profile.proxyId ?? null),
        proxyUrl: launchProxyUrl,
        proxySource,
        engineKind: this.runtime.kind,
      });
      void session.exited.then(({ code, signal }) =>
        this.onEngineExit(profileId, live.id, code, signal),
      );
      this.emit({
        type: "run.started",
        profileId,
        runId: live.id,
        at: now(),
        detail: this.runtime.kind,
      });
      return live;
    });
  }

  async stop(profileId: string): Promise<BrowserRun | null> {
    return this.mutex.runExclusive(profileId, async () => {
      const profile = this.requireProfile(profileId);
      const run = this.runs.occupyingForProfile(profileId);
      if (!run) return null; // idempotent stop
      const session = this.sessions.get(profileId);
      this.sessions.delete(profileId);
      // Mark the row stopped BEFORE stopping the engine: session.stop()
      // resolves the exit promise, and the exit handler consults this row to
      // decide whether the exit was already accounted for. Writing first is
      // what makes a deliberate stop emit exactly one event.
      const stopped: BrowserRun = {
        ...run,
        status: "stopped",
        stoppedAt: now(),
      };
      this.runs.update(stopped);
      this.markProfile(profile, "idle");
      this.tabRegistry.clearRun(run.id); // tabs die with the run
      try {
        await session?.stop();
      } catch {
        // Engine may already be gone; the row is already reconciled above.
      }
      this.emit({
        type: "run.stopped",
        profileId,
        runId: run.id,
        at: now(),
        detail: "",
      });
      return stopped;
    });
  }

  activeRun(profileId: string): BrowserRun | null {
    return this.runs.occupyingForProfile(profileId);
  }

  /**
   * The live engine session for a profile with an occupying run, or null.
   * Session-level features (bundle export/import) use this; null can mean
   * "not running" or "adopted after an API restart" — callers that care
   * distinguish via activeRun().
   */
  sessionFor(profileId: string): BrowserSession | null {
    return this.sessions.get(profileId) ?? null;
  }

  /** The runtime kind behind every session (manifest metadata for bundles). */
  engineKind(): string {
    return this.runtime.kind;
  }

  listRuns(profileId: string): BrowserRun[] {
    return this.runs.listForProfile(profileId);
  }

  /**
   * Open a tab in the profile's active run. Without `relatedTo` the tab gets
   * its own isolated session partition; with it, the tab shares the parent's
   * partition (the Jancy "related tabs" model). Refuses honestly when there
   * is no run, when the run was adopted after a restart (tab state unknown),
   * or when the runtime cannot manage tabs at all.
   */
  async openTab(profileId: string, input: OpenTabInput): Promise<BrowserTab> {
    return this.mutex.runExclusive(profileId, async () => {
      const profile = this.requireProfile(profileId);
      const run = this.runs.occupyingForProfile(profileId);
      if (!run) {
        throw new DomainError(
          ErrorCodes.PROFILE_NOT_RUNNING,
          `profile ${profileId} has no active browser run`,
        );
      }
      const session = this.sessions.get(profileId);
      if (!session) {
        throw new DomainError(
          ErrorCodes.TABS_UNSUPPORTED,
          `run ${run.id} was adopted after an API restart — its tab state is unknown; stop and relaunch to manage tabs`,
        );
      }
      if (!session.openTab) {
        throw new DomainError(
          ErrorCodes.TABS_UNSUPPORTED,
          `runtime "${this.runtime.kind}" does not implement tab management`,
        );
      }

      const { partition, relatedToTabId } = this.tabRegistry.resolvePartition(
        run.id,
        input.relatedTo ?? null,
      );
      let engineTabId: string | null = null;
      try {
        const opened = await session.openTab({
          url: input.url ?? null,
          partitionKey: partition.id,
        });
        engineTabId = opened.engineTabId;
      } catch (err) {
        // Engine refused — drop a partition we created for nothing.
        this.tabRegistry.dropPartitionIfEmpty(partition.id);
        throw err instanceof DomainError
          ? err
          : new DomainError(
              ErrorCodes.ENGINE_LAUNCH_FAILED,
              err instanceof Error ? err.message : String(err),
            );
      }

      const tab = this.tabRegistry.recordTab({
        runId: run.id,
        profileId,
        partitionId: partition.id,
        engineTabId,
        url: input.url ?? null,
        relatedToTabId,
      });
      this.emit({
        type: "tab.opened",
        profileId,
        runId: run.id,
        tabId: tab.id,
        at: now(),
        detail: tab.url ?? "",
      });
      return tab;
    });
  }

  /** Close a tab. Idempotent: closing an already-closed tab returns it. */
  async closeTab(profileId: string, tabId: string): Promise<BrowserTab> {
    return this.mutex.runExclusive(profileId, async () => {
      this.requireProfile(profileId);
      const run = this.runs.occupyingForProfile(profileId);
      if (!run) {
        throw new DomainError(
          ErrorCodes.PROFILE_NOT_RUNNING,
          `profile ${profileId} has no active browser run`,
        );
      }
      const tab = this.tabRegistry.getForRun(run.id, tabId);
      if (tab.status === "closed") return tab; // idempotent close
      const session = this.sessions.get(profileId);
      if (session?.closeTab && tab.engineTabId) {
        try {
          await session.closeTab(tab.engineTabId);
        } catch {
          // Engine may already be gone; the registry is reconciled regardless.
        }
      }
      const closed = this.tabRegistry.markClosed(tabId);
      this.emit({
        type: "tab.closed",
        profileId,
        runId: run.id,
        tabId: tab.id,
        at: now(),
        detail: "",
      });
      return closed;
    });
  }

  /** Tabs and partitions of the profile's active run; empty when not running. */
  listTabs(profileId: string): {
    tabs: BrowserTab[];
    partitions: SessionPartition[];
  } {
    const run = this.runs.occupyingForProfile(profileId);
    if (!run) return { tabs: [], partitions: [] };
    return this.tabRegistry.listForRun(run.id);
  }

  /**
   * "Applies at next start" check: diff the active run's launch snapshot
   * against the profile's current identity/proxy pointers. Null when the
   * profile has no active run or the run predates snapshots.
   */
  identityDrift(profileId: string): IdentityDrift | null {
    if (!this.snapshots) return null;
    const run = this.runs.occupyingForProfile(profileId);
    if (!run) return null;
    const profile = this.profiles.get(profileId);
    if (!profile) return null;
    return this.snapshots.drift(run.id, {
      identityId: profile.identityId,
      proxyId: profile.proxyId,
    });
  }

  /**
   * Fingerprint attestation: probe the live engine for what it ACTUALLY
   * materialized and compare against the run's launch-snapshot identity.
   * Verdict "match" is only ever returned when observed values agree —
   * a runtime without probe support answers ATTESTATION_UNSUPPORTED instead.
   */
  async attest(profileId: string): Promise<AttestationResult> {
    const profile = this.requireProfile(profileId);
    const run = this.runs.occupyingForProfile(profileId);
    if (!run) {
      throw new DomainError(
        ErrorCodes.PROFILE_NOT_RUNNING,
        `profile ${profileId} has no active browser run`,
      );
    }
    const session = this.sessions.get(profileId);
    if (!session?.captureFingerprint) {
      throw new DomainError(
        ErrorCodes.ATTESTATION_UNSUPPORTED,
        session
          ? `runtime "${this.runtime.kind}" does not implement fingerprint capture`
          : `run ${run.id} was adopted after an API restart — its engine session is not attached; stop and relaunch to attest`,
      );
    }
    const observed = await session.captureFingerprint();
    const identity = this.snapshots?.forRun(run.id)?.identity ?? null;
    const { verdict, differences } = compareFingerprint(identity, observed);
    return {
      profileId: profile.id,
      runId: run.id,
      verdict,
      observed,
      differences,
      capturedAt: now(),
    };
  }

  /**
   * Boot-time reconciliation. Runs still marked occupying when the API starts
   * are checked against the real OS process table: alive PID → adopt as
   * running (the browser outlived us); dead PID → mark crashed. This is what
   * makes restart after a crash safe instead of corrupting profile state.
   */
  reconcileOnBoot(): { adopted: number; crashed: number } {
    let adopted = 0;
    let crashed = 0;
    for (const run of this.runs.listOccupying()) {
      if (run.pid && isProcessAlive(run.pid)) {
        if (run.status !== "running") {
          this.runs.update({ ...run, status: "running" });
        }
        adopted++;
      } else {
        this.runs.update({
          ...run,
          status: "crashed",
          stoppedAt: now(),
          lastError: "engine process not found at API startup",
        });
        const profile = this.profiles.get(run.profileId);
        if (profile) this.markProfile(profile, "idle");
        this.emit({
          type: "run.crashed",
          profileId: run.profileId,
          runId: run.id,
          at: now(),
          detail: "reconciled at boot",
        });
        crashed++;
      }
    }
    return { adopted, crashed };
  }

  private onEngineExit(
    profileId: string,
    runId: string,
    code: number | null,
    signal: string | null,
  ): void {
    const run = this.runs.get(runId);
    if (!run || (run.status !== "running" && run.status !== "launching"))
      return;
    this.sessions.delete(profileId);
    this.tabRegistry.clearRun(runId); // tabs die with the engine
    const clean = code === 0;
    const final: BrowserRun = {
      ...run,
      status: clean ? "stopped" : "crashed",
      stoppedAt: now(),
      lastError: clean
        ? null
        : `engine exited (code=${code}, signal=${signal})`,
    };
    this.runs.update(final);
    const profile = this.profiles.get(profileId);
    if (profile) this.markProfile(profile, clean ? "idle" : "error");
    this.emit({
      type: clean ? "run.stopped" : "run.crashed",
      profileId,
      runId,
      at: now(),
      detail: final.lastError ?? "clean exit",
    });
  }

  private failRun(run: BrowserRun, profile: Profile, err: unknown): void {
    this.runs.update({
      ...run,
      status: "crashed",
      stoppedAt: now(),
      lastError:
        err instanceof Error ? err.message.slice(0, 2000) : String(err),
    });
    this.markProfile(profile, "error");
    this.emit({
      type: "run.crashed",
      profileId: profile.id,
      runId: run.id,
      at: now(),
      detail: "launch failed",
    });
  }

  private markProfile(profile: Profile, status: Profile["status"]): void {
    this.profiles.update({ ...profile, status, updatedAt: now() });
  }

  private requireProfile(id: string): Profile {
    const p = this.profiles.get(id);
    if (!p)
      throw new DomainError(
        ErrorCodes.PROFILE_NOT_FOUND,
        `profile ${id} not found`,
      );
    return p;
  }

  private emit(e: LifecycleEvent): void {
    this.events.emit("lifecycle", e);
  }
}

function now(): string {
  return new Date().toISOString();
}
