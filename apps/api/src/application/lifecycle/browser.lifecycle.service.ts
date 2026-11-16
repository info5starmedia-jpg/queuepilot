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
  type RotationLink,
  type SessionPartition,
  type TempProxyInput,
} from "@queuepilot/contracts";
import { isProcessAlive, captureProcessStartToken } from "../../infrastructure/process-inventory.js";
import { compareFingerprint } from "../profiles/fingerprint-attestation.js";
import { currentProfileProxy } from "../profiles/profile-proxies.js";
import { rotationLinkOf } from "../profiles/rotation-link.js";
import { startUrlsOf } from "../profiles/start-pages.js";
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
import type { LaunchIdentitySnapshot } from "@queuepilot/contracts";
import { TabRegistry } from "../tabs/tab-registry.js";

/**
 * Credential-redact a proxy URL for diagnostics: the operator needs host,
 * port and scheme — never the user:pass that may sit in the authority.
 */
export function redactProxyUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.username || u.password) u.username = "***";
    u.password = "";
    return u.toString();
  } catch {
    return "(unparseable proxy url)";
  }
}

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
  /** Per-run lease heartbeats (audit B1); cleared with the session. */
  private readonly leaseRenewers = new Map<string, ReturnType<typeof setInterval>>();
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
    /**
     * Optional cross-machine launch guard (P7.7b): acquire() runs before the
     * launch is admitted and may throw (LEASE_HELD / server down); release()
     * runs on explicit stop. renew(), when present, is heartbeat-called by the
     * lifecycle for every live run so a long session never outlives its TTL
     * (audit B1). Absent = single-machine deployments, untouched.
     */
    private readonly leaseGuard?: {
      acquire(profileId: string): Promise<void>;
      release(profileId: string): Promise<void>;
      renew?(profileId: string): Promise<void>;
    },
    /** How often a live run renews its lease. Default 30 s (TTL 60 s). */
    private readonly leaseRenewIntervalMs = 30_000,
    /**
     * D-003: rotation-link resolver. When a profile carries
     * `extra.rotationLink` and nothing more specific decides its proxy, the
     * launch endpoint comes from the linked provider's pool. Absent = rotation
     * links refuse loudly instead of silently launching direct.
     */
    private readonly rotationProviders?: {
      resolveRotation(link: RotationLink): {
        id: string;
        type: "http" | "https" | "socks5";
        host: string;
        port: number;
        username: string | null;
        password: string | null;
      };
    },
  ) {
    this.events.setMaxListeners(0);
  }

  async start(profileId: string, opts: StartOptions = {}): Promise<BrowserRun> {
    const live = await this.mutex.runExclusive(profileId, async () => {
      const profile = this.requireProfile(profileId);
      if (this.runs.occupyingForProfile(profileId)) {
        throw new DomainError(
          ErrorCodes.PROFILE_ALREADY_RUNNING,
          `profile ${profileId} already has an active browser run`,
        );
      }

      // Cross-machine double-start guard (P7.7b): BEFORE any run row is
      // written, so a refused start leaves no trace behind. Fail closed —
      // an unreachable team server refuses the launch rather than skipping
      // the guard.
      if (this.leaseGuard) await this.leaseGuard.acquire(profileId);
      try {
        return await this.launchInner(profile, opts);
      } finally {
        // launchInner() rethrows on failure; the row/state cleanup happens in
        // its catch, but the lease is OURS to give back either way. A live
        // session (now in this.sessions) keeps its lease until stop().
        if (!this.sessions.has(profileId)) {
          await this.leaseGuard?.release(profileId).catch(() => {});
        }
      }
    });

    // Jancy URL start pages: after the run is up (and OUTSIDE the launch
    // lock — openTab takes the same mutex), open each configured page. A
    // failed page never fails the launch; it reports one startpage.failed
    // event per refusal so the console can surface it.
    const startUrls = startUrlsOf(this.requireProfile(profileId).extra);
    for (const url of startUrls) {
      try {
        await this.openTab(profileId, { url });
      } catch (err) {
        this.emit({
          type: "startpage.failed",
          profileId,
          runId: live.id,
          at: now(),
          detail: `${url}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500),
        });
      }
    }
    return live;
  }

  /**
   * Everything after the guards: proxy resolution, run row, spawn, session
   * bookkeeping. Lives in its own method so start()'s lease guard can wrap it
   * in a try/finally (release the lease on a failed launch, keep it on
   * success until stop()).
   */
  private async launchInner(profile: Profile, opts: StartOptions): Promise<BrowserRun> {
    const profileId = profile.id;
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
      // Jancy per-profile proxy list: when neither a temp proxy nor an
      // attached proxy decides the launch, the list's current entry does.
      // "system connection" entries mean a direct connection. Nothing is
      // persisted at launch — the index only moves via proxies/rotate.
      const listCurrent =
        !tempProxy && !attached ? currentProfileProxy(profile.extra) : null;
      const listDirect =
        listCurrent?.entry.kind === "direct" ? listCurrent.entry : null;
      // D-003 rotation link: only when nothing more specific decided the
      // proxy (no temp, no attached, no proxy list). A configured link with
      // no resolver wired is a launch-time refusal, never a silent direct
      // connection — a silent fallback would out the real egress IP.
      const rotationLink =
        !tempProxy && !attached && !listCurrent ? rotationLinkOf(profile.extra) : null;
      if (rotationLink && !this.rotationProviders) {
        throw new DomainError(
          ErrorCodes.VALIDATION_FAILED,
          "profile has a rotation link but no proxy-provider service is wired",
        );
      }
      const rotated = rotationLink
        ? this.rotationProviders!.resolveRotation(rotationLink)
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
          : listDirect
            ? proxyUrl({
                type: listDirect.scheme,
                host: listDirect.host,
                port: listDirect.port,
                username: listDirect.username,
                password: listDirect.password,
              })
            : rotated
              ? proxyUrl(rotated)
              : null;
      const proxySource = tempProxy
        ? ("temporary" as const)
        : attached
          ? ("profile" as const)
          : listCurrent
            ? ("profile-list" as const)
            : rotated
              ? ("rotation" as const)
              : ("none" as const);

      const run: BrowserRun = {
        id: randomUUID(),
        profileId,
        status: "launching",
        pid: null,
        processToken: null, // captured from the live engine right after spawn
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
        // D-002: the anti-PID-reuse token rides the run row from here on.
        // Null (capture failed) is fine — reconciliation then falls back to
        // plain liveness, never to a guessed death.
        processToken: captureProcessStartToken(session.pid),
        debugPort: session.debugPort,
        wsEndpoint: session.wsEndpoint,
      };
      this.runs.update(live);
      this.sessions.set(profileId, session);
      this.startLeaseRenewal(profileId);
      // Identity of record: snapshot exactly what the engine launched with.
      // Later edits to the profile drift against this and apply at next start.
      this.snapshots?.capture({
        runId: live.id,
        profile,
        identity,
        proxyId: tempProxy ? null : (rotated?.id ?? profile.proxyId ?? null),
        proxyUrl: launchProxyUrl,
        proxySource,
        engineKind: this.runtime.kind,
        egress: session.egress ?? undefined,
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
  }

  async stop(profileId: string): Promise<BrowserRun | null> {
    return this.mutex.runExclusive(profileId, async () => {
      const profile = this.requireProfile(profileId);
      const run = this.runs.occupyingForProfile(profileId);
      if (!run) return null; // idempotent stop
      const session = this.sessions.get(profileId);
      this.sessions.delete(profileId);
      this.stopLeaseRenewal(profileId);
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
      await this.leaseGuard?.release(profileId).catch(() => {}); // TTL reaps a lost release
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
   * Lease heartbeat (audit B1): the server-side TTL is 60 s, so without
   * renewal the cross-machine double-start guard silently expired one minute
   * into every session. One unref'd timer per live run; each tick no-ops
   * itself out if the run is no longer occupying (a missed exit path).
   */
  private startLeaseRenewal(profileId: string): void {
    if (!this.leaseGuard?.renew) return;
    if (this.leaseRenewers.has(profileId)) return;
    const timer = setInterval(() => {
      if (!this.runs.occupyingForProfile(profileId)) {
        this.stopLeaseRenewal(profileId);
        return;
      }
      void this.leaseGuard?.renew?.(profileId).catch(() => {
        /* best-effort; the next tick retries, TTL reaps a truly dead lease */
      });
    }, this.leaseRenewIntervalMs);
    timer.unref?.();
    this.leaseRenewers.set(profileId, timer);
  }

  private stopLeaseRenewal(profileId: string): void {
    const timer = this.leaseRenewers.get(profileId);
    if (timer) clearInterval(timer);
    this.leaseRenewers.delete(profileId);
  }

  /**
   * AliasMode delete discipline: a profile delete must wait out any in-flight
   * start/stop for the profile and then confirm nothing occupies it — on
   * Windows, deleting a profile directory the engine still holds files in
   * fails with EBUSY, and the profile row must never say "deleted" while the
   * engine is still tearing down. Serializes on the same per-profile mutex as
   * start/stop, so a delete queued behind a stop sees the finished state.
   */
  async ensureIdle(profileId: string): Promise<void> {
    return this.mutex.runExclusive(profileId, async () => {
      if (this.runs.occupyingForProfile(profileId)) {
        throw new DomainError(
          ErrorCodes.CONFLICT,
          "stop the browser before deleting the profile",
        );
      }
    });
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
   * Egress diagnostics (P7): what the running launch measured at launch —
   * proxy chain, relay port, exit address, WebRTC keys. Serves the LAUNCH
   * measurements verbatim, never a fresh re-check (a re-check would race a
   * rotating proxy and could contradict the running engine). proxyUrl is
   * credential-redacted: the operator sees where traffic exits, the response
   * never carries proxy passwords.
   */
  egressDiagnostics(profileId: string): {
    profileId: string;
    running: boolean;
    engineKind: string;
    proxyUrl: string | null;
    proxySource: "profile" | "temporary" | "profile-list" | "rotation" | "none";
    egress: LaunchIdentitySnapshot["egress"] | null;
  } | null {
    const run = this.runs.occupyingForProfile(profileId);
    const snapshot = run && this.snapshots ? this.snapshots.forRun(run.id) : null;
    return {
      profileId,
      running: run !== null && run.status === "running",
      engineKind: snapshot?.engineKind ?? this.runtime.kind,
      proxyUrl: redactProxyUrl(snapshot?.proxyUrl ?? null),
      proxySource: snapshot?.proxySource ?? "none",
      egress: snapshot?.egress ?? null,
    };
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
   * are checked against the real OS process table: alive PID with a matching
   * start token → adopt as running (the browser outlived us); dead PID OR
   * alive-but-different token (PID reused by a stranger) → mark crashed. This
   * is what makes restart after a crash safe instead of corrupting profile
   * state.
   */
  reconcileOnBoot(): { adopted: number; crashed: number } {
    let adopted = 0;
    let crashed = 0;
    for (const run of this.runs.listOccupying()) {
      if (run.pid && isProcessAlive(run.pid, run.processToken)) {
        if (run.status !== "running") {
          this.runs.update({ ...run, status: "running" });
        }
        adopted++;
      } else {
        this.runs.update({
          ...run,
          status: "crashed",
          stoppedAt: now(),
          lastError: "engine process not found (or its PID reused) at API startup",
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
    this.stopLeaseRenewal(profileId);
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
