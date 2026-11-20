import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import path from "node:path";
import {
  DomainError,
  ErrorCodes,
  computeIdentityDrift,
  TempProxyInputSchema,
  type AttestationResult,
  type BrowserRun,
  type BrowserTab,
  type IdentityDrift,
  type FingerprintIdentityOverrides,
  type LifecycleEvent,
  type OpenTabInput,
  type FingerprintIdentityWithOverrides,
  type Profile,
  type RotationLink,
  type SessionPartition,
  type TempProxyInput,
} from "@queuepilot/contracts";
import {
  captureProcessStartTokens,
  checkProcessIdentity,
  startTokenForRun,
  terminateProcess,
  waitForProcessExit,
} from "../../infrastructure/process-inventory.js";
import { CdpConnection } from "../runtime/cdp/cdp-connection.js";
import { holdRelayPort, type RelayPortHold } from "../runtime/proxy-relay.js";
import { compareFingerprint } from "../profiles/fingerprint-attestation.js";
import { hostMemoryGb, hostPrimaryDisplay } from "../profiles/host-display.js";
import { currentProfileProxy } from "../profiles/profile-proxies.js";
import { rotationLinkOf } from "../profiles/rotation-link.js";
import { startUrlsOf } from "../profiles/start-pages.js";
import type {
  ProfileRepository,
  FingerprintIdentityRepository,
} from "../profiles/profile.repository.js";
import { isFreshProbe, type ProxyService } from "../proxies/proxy.service.js";
import type { BrowserRunRepository } from "./browser-run.repository.js";
import { ProfileOperationMutex } from "./profile-operation.mutex.js";
import { proxyUrl } from "@queuepilot/contracts";
import type {
  BrowserRuntime,
  BrowserSession,
} from "../runtime/browser-runtime.js";
import type { LaunchIdentityService } from "./launch-identity.service.js";
import type { LaunchIdentitySnapshot, ProxyProbe } from "@queuepilot/contracts";
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
  /**
   * D-002 recovery counters, surfaced by GET /metrics. "Unverified" = adopted
   * on liveness alone (no start token, or the OS refused the read).
   */
  readonly recoveryCounters = {
    runsAdopted: 0,
    runsAdoptedUnverified: 0,
    runsReconciledCrashed: 0,
    /** Adopted proxied runs whose dead relay port we now hold (fails closed). */
    relaysHeld: 0,
    /** Adopted proxied runs whose relay port another process already owned. */
    relaysUnguarded: 0,
  };
  /**
   * Adopted proxied runs → the placeholder holding their dead relay port, or
   * null when the port was already taken by someone else. See holdRelayPort.
   */
  private readonly relayHolds = new Map<string, RelayPortHold | null>();
  /** Per-tab auto-reload timers (tab id → run, interval, timer). */
  private readonly autoReloads = new Map<
    string,
    { runId: string; profileId: string; sec: number; timer: ReturnType<typeof setInterval> }
  >();
  /** ms per auto-reload "second" — tests shrink it. */
  private autoReloadUnitMs = 1000;
  /**
   * How long an adopted engine gets to exit after each stop request
   * (Browser.close, graceful kill, forced kill) before the next escalation.
   */
  private adoptedStopGraceMs = 10_000;
  /** Adopted-run watcher (D-002 follow-up); null when nothing is adopted. */
  private adoptedWatcher: ReturnType<typeof setInterval> | null = null;
  private adoptedWatchIntervalMs = 15_000;
  /**
   * Engine liveness watchdog: a fury-core engine can outlive its own DevTools
   * server (found live 2026-11-20 — TCP accepts but answers nothing after a
   * Target.closeTarget; process idle, run row "running" forever). One global
   * unref'd timer probes every session's debug port; N consecutive failures
   * latch the run DEGRADED (run.degraded event + isDegraded flag) until a
   * probe succeeds or the run ends. Never auto-restarts: the browser window
   * may still be in use even when uncommandable.
   */
  private livenessTimer: ReturnType<typeof setInterval> | null = null;
  /** profileId -> consecutive failed probes. */
  private readonly livenessFailures = new Map<string, number>();
  /** runIds currently latched degraded. */
  private readonly degradedRuns = new Set<string>();
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
        lastProbe?: ProxyProbe | null;
      };
    },
    /**
     * Looks up a proxy's exit IP — its IANA timezone and ISO country — by
     * making a request THROUGH that proxy (the same geo-IP echo the proxy
     * Test uses). One lookup serves both the launch timezone and the launch
     * locale. Absent = no lookup; the proxy's own timezone field and pins
     * still apply.
     */
    private readonly proxyGeoLookup?: (proxy: LaunchProxyEndpoint) => Promise<ProxyExitGeo | null>,
    /**
     * The machine's own timezone, for direct (no-proxy) launches: a direct
     * connection's IP is the machine's, so the coherent clock is the
     * machine's — anything else (e.g. the identity's UTC default) is a
     * contradiction checkers flag. Defaults to the real system zone;
     * injectable so tests are machine-independent.
     */
    private readonly hostTimezone: () => string | null = systemHostTimezone,
    /**
     * Engine liveness watchdog tuning (probe is injectable so tests stay
     * offline). Defaults: 20s interval, 3 consecutive failures to latch
     * (≈60s of silence), 4s per-probe timeout, real HTTP probe of the debug
     * port's /json/version.
     */
    private readonly liveness?: {
      intervalMs?: number;
      threshold?: number;
      probeTimeoutMs?: number;
      probe?: (port: number, timeoutMs: number) => Promise<boolean>;
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
    // The engine always spawns one stray blank "window anchor" tab even
    // with no CLI URLs (startUrls now open exclusively via CDP). Close it
    // once the real pages are up so a launch leaves exactly its startUrls.
    if (startUrls.length > 0) {
      try {
        await this.sessions.get(profileId)?.closeInitialBlankTab?.();
      } catch {
        // Best-effort: a leftover blank tab is cosmetic, never launch-fatal.
      }
    }
    return live;
  }

  /**
   * Launch-time host coherence (owner decision 2026-11-20): a profile running
   * on THIS machine presents THIS machine's display and a memory claim the
   * host can back. Identities minted before host info was wired (or on a
   smaller machine) claim 1366x768-style screens — windows open small, and
   the window-fit watcher reverts any maximize/fullscreen that exceeds the
   claimed area (the "fullscreen pops up and disappears" report). A 4 GB
   memory claim on an 8+ GB host is likewise flagged by fingerprint checks
   (V8's heap limit exposes real RAM). The correction is written as identity
   OVERRIDES (pins) on the existing row — the row itself stays immutable, the
   profile's identityId never churns, and the dashboard's identity editor
   shows the pins transparently. Operator-pinned fields are left alone; after
   pinning, the staleness check sees the pinned values and skips, so this
   costs one small write per stale profile, never a loop.
   */
  private ensureHostCoherentIdentity(profile: Profile): Profile {
    const cur = profile.identityId ? this.identities.get(profile.identityId) : null;
    if (!cur) return profile;
    const host = hostPrimaryDisplay();
    const hostMem = hostMemoryGb();
    /* An operator-pinned field is deliberate — never override it. Pins also
       keep this idempotent: after pinning, the staleness check below sees the
       pinned values and skips, so this writes once per stale profile, never
       in a loop. The identity ROW is untouched (immutable by design;
       identityId stays stable across launch/refresh). */
    const pins = cur.overrides ?? {};
    const patch: Record<string, unknown> = {};
    if (
      host &&
      pins.screenWidth === undefined &&
      (cur.screenWidth !== host.width || cur.screenHeight !== host.height)
    ) {
      patch.screenWidth = host.width;
      patch.screenHeight = host.height;
    }
    if (hostMem >= 8 && cur.deviceMemoryGb <= 4 && pins.deviceMemoryGb === undefined) {
      patch.deviceMemoryGb = 8; // smallest coherent bucket (generator rule: >4, ≤ host)
      if (pins.hardwareConcurrency === undefined) patch.hardwareConcurrency = 4; // tier-correct minimum
    }
    if (Object.keys(patch).length === 0) return profile;
    this.identities.setOverrides(profile.identityId!, { ...pins, ...patch } as FingerprintIdentityOverrides);
    return profile;
  }

  /**
   * Everything after the guards: proxy resolution, run row, spawn, session
   * bookkeeping. Lives in its own method so start()'s lease guard can wrap it
   * in a try/finally (release the lease on a failed launch, keep it on
   * success until stop()).
   */
  private async launchInner(profile: Profile, opts: StartOptions): Promise<BrowserRun> {
    const profileId = profile.id;
    profile = this.ensureHostCoherentIdentity(profile);
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
      // P-LOCK: the first launch of a sticky link pins the endpoint it got,
      // so every later launch of this profile gets the same IP. Written to
      // the fresh row so nothing else on the profile is clobbered.
      const freshRow = rotationLink?.mode === "sticky" && !rotationLink.pinned && rotated
        ? (this.profiles.get(profileId) ?? null)
        : null;
      // Audit: re-check the CURRENT link — if it was changed or removed while
      // this launch was being admitted, don't resurrect the old one.
      const freshLink = freshRow ? rotationLinkOf(freshRow.extra) : null;
      if (
        freshRow &&
        freshLink &&
        rotated &&
        freshLink.mode === "sticky" &&
        !freshLink.pinned &&
        freshLink.providerId === rotationLink!.providerId
      ) {
        const fresh = freshRow;
        this.profiles.update({
          ...fresh,
          extra: {
            ...(fresh.extra ?? {}),
            rotationLink: {
              ...freshLink,
              pinned: {
                host: rotated.host,
                port: rotated.port,
                username: rotated.username,
                pinnedAt: new Date().toISOString(),
              },
            },
          },
          updatedAt: new Date().toISOString(),
        });
      }
      const launchProxy: LaunchProxyEndpoint | null = tempProxy
        ? {
            type: tempProxy.type,
            host: tempProxy.host,
            port: tempProxy.port,
            username: tempProxy.username ?? null,
            password: tempProxy.password ?? null,
          }
        : attached
          ? attached
          : listDirect
            ? {
                type: listDirect.scheme,
                host: listDirect.host,
                port: listDirect.port,
                username: listDirect.username,
                password: listDirect.password,
              }
            : rotated
              ? rotated
              : null;
      const launchProxyUrl = launchProxy ? proxyUrl(launchProxy) : null;
      const proxySource = tempProxy
        ? ("temporary" as const)
        : attached
          ? ("profile" as const)
          : listCurrent
            ? ("profile-list" as const)
            : rotated
              ? ("rotation" as const)
              : ("none" as const);

      // The browser's clock and locale follow the proxy's exit IP: a proxied
      // profile on a UTC (or home) clock, or with en-US formatting behind a
      // German exit, contradicts the IP's location — exactly what checkers
      // flag. Timezone: pin > proxy's own timezone > exit-IP lookup >
      // identity. Locale: pin > exit country > identity.
      const { timezone: launchTimezone, source: timezoneSource, locale: launchLocale, localeSource } =
        await this.resolveLaunchGeo(identity, launchProxy, attached?.timezone ?? null, attached ?? rotated);
      const launchIdentity =
        identity &&
        ((launchTimezone && launchTimezone !== identity.timezone) ||
          (launchLocale && launchLocale !== identity.locale))
          ? {
              ...identity,
              ...(launchTimezone ? { timezone: launchTimezone } : {}),
              ...(launchLocale ? { locale: launchLocale } : {}),
            }
          : identity;

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
          identity: launchIdentity,
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
        // A token older than this run's own start is a stranger's — dropped.
        processToken: startTokenForRun(session.pid, run.startedAt),
        debugPort: session.debugPort,
        wsEndpoint: session.wsEndpoint,
      };
      this.runs.update(live);
      this.sessions.set(profileId, session);
      this.startLeaseRenewal(profileId);
      this.ensureLivenessTimer();
      // Identity of record: snapshot exactly what the engine launched with.
      // Later edits to the profile drift against this and apply at next start.
      this.snapshots?.capture({
        runId: live.id,
        profile,
        identity: launchIdentity,
        proxyId: tempProxy ? null : (rotated?.id ?? profile.proxyId ?? null),
        proxyUrl: launchProxyUrl,
        proxySource,
        engineKind: this.runtime.kind,
        egress: session.egress ?? undefined,
        timezoneSource,
        localeSource,
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
      this.clearLivenessState(profileId, run.id);
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
      this.clearAutoReloadsForRun(run.id);
      this.tabRegistry.clearRun(run.id); // tabs die with the run
      await this.leaseGuard?.release(profileId).catch(() => {}); // TTL reaps a lost release
      let final = stopped;
      if (session) {
        try {
          await session.stop();
        } catch {
          // Engine may already be gone; the row is already reconciled above.
        }
      } else {
        // Adopted after an API restart: there is no session handle, but Stop
        // must still mean "the browser is gone" (D-002 follow-up).
        const note = await this.stopAdoptedEngine(run);
        // Keep holding the dead relay port while the engine may still run
        // (a note means it may); release only once it is gone.
        if (!note) this.releaseRelayHold(run.id);
        if (note) {
          final = { ...stopped, lastError: note };
          this.runs.update(final);
        }
      }
      this.emit({
        type: "run.stopped",
        profileId,
        runId: run.id,
        at: now(),
        detail: final.lastError ?? "",
      });
      return final;
    });
  }

  /**
   * Stop the engine of a run that has no in-memory session (adopted after an
   * API restart). The PID on the row is only a number by now, so identity
   * decides how far we may go:
   *
   *  1. Ask the engine itself: CDP `Browser.close` on the stored endpoint —
   *     a clean shutdown, and it cannot hit a non-browser stranger.
   *  2. Kill by PID ONLY when the start token proves the process is ours
   *     ("match"), graceful first, forced after the grace window.
   *  3. Otherwise never kill. A tokenless or unreadable process that ignored
   *     Browser.close is left alone and the row says so.
   *
   * Returns null when the engine is gone, or a note for `lastError` when it
   * may still be running.
   */
  private async stopAdoptedEngine(run: BrowserRun): Promise<string | null> {
    const pid = run.pid;
    if (!pid) return null; // died mid-launch before a PID was recorded
    const identity = checkProcessIdentity(pid, run.processToken);
    if (identity === "dead") return null;
    if (identity === "mismatch") {
      // Our engine is long gone; this PID (and likely the debug port) is
      // somebody else's now. Touch nothing.
      return "engine PID was reused by another process; nothing was stopped";
    }
    const grace = this.adoptedStopGraceMs;
    const unproven =
      `engine (pid ${pid}) may still be running: its identity could not be proven ` +
      `(${run.processToken ? "start time unreadable" : "no start token on record"}), ` +
      "so it was not killed by PID — close the browser window manually";
    let waited = false;
    if (run.wsEndpoint) {
      try {
        const conn = await CdpConnection.connect(run.wsEndpoint, 3_000);
        waited = true;
        try {
          // The socket drops as the browser exits, so a rejected call is
          // expected — what counts is whether the process goes away.
          await conn.call("Browser.close", {}, 3_000).catch(() => {});
        } finally {
          conn.close();
        }
        if (await waitForProcessExit(pid, grace)) return null;
      } catch {
        // No DevTools endpoint answering — fall through to the PID path.
      }
    }
    if (identity !== "match") return unproven;
    // Identity is re-proven immediately before EVERY kill: any wait above is
    // long enough for the engine to exit and its PID to be handed to someone
    // else. Gone or reused → our engine is dead, nothing to do. Unreadable →
    // no longer provable, so no kill.
    const reprove = (): string | null | "kill" => {
      const again = checkProcessIdentity(pid, run.processToken);
      if (again === "dead" || again === "mismatch") return null;
      return again === "match" ? "kill" : unproven;
    };
    if (waited) {
      const verdict = reprove();
      if (verdict !== "kill") return verdict;
    }
    await terminateProcess(pid, false);
    if (await waitForProcessExit(pid, grace)) return null;
    const verdict = reprove();
    if (verdict !== "kill") return verdict;
    await terminateProcess(pid, true);
    if (await waitForProcessExit(pid, grace)) return null;
    return `engine (pid ${pid}) did not exit after a forced stop`;
  }

  /**
   * The timezone and locale this launch should present, and why.
   *
   * Timezone: a profile pin always wins; then the proxy's own timezone field
   * (the operator knows better than any database); then the exit IP's
   * timezone looked up through the proxy; with no proxy, the machine's own
   * timezone (a direct connection's IP is the machine's — only the identity
   * default would contradict it, as AliasMode's check flags "Browser UTC, IP
   * America/Toronto"); otherwise the identity default.
   *
   * Locale (Intl date/number formatting): a profile pin wins; then the
   * locale of the exit IP's country (DE → de-DE). iphey scored the same
   * engine and persona "Unreliable" with en-US behind a German exit and
   * "Trustworthy 100" with de-DE (measured 2026-11-19). With no proxy the
   * identity's locale stays — the operator chose it for their own machine.
   *
   * One exit lookup serves both, made only when one of them needs it. A
   * failed lookup is never a launch failure — the values may not match the
   * IP, but nothing leaks.
   *
   * A saved proxy whose last probe succeeded within 24 h answers from that
   * probe instead (no live lookup, no launch delay). A live lookup on a saved
   * proxy is stored back on it so the next launch is instant.
   */
  private async resolveLaunchGeo(
    identity: FingerprintIdentityWithOverrides | null,
    proxy: LaunchProxyEndpoint | null,
    proxyTimezone: string | null,
    saved: { id: string; lastProbe?: ProxyProbe | null } | null = null,
  ): Promise<{
    timezone: string | null;
    source: "pinned" | "proxy" | "exit-ip" | "host" | "identity";
    locale: string | null;
    localeSource: "pinned" | "exit-ip" | "identity";
  }> {
    if (!identity) return { timezone: null, source: "identity", locale: null, localeSource: "identity" };
    const stored = { locale: identity.locale, localeSource: "identity" as const };
    const localePinned = Boolean(identity.overrides?.locale);
    const locale = localePinned ? { locale: identity.locale, localeSource: "pinned" as const } : stored;
    if (!proxy) {
      if (identity.overrides?.timezone) return { timezone: identity.timezone, source: "pinned", ...locale };
      const host = this.hostTimezone();
      if (host && isValidTimezone(host)) return { timezone: host, source: "host", ...locale };
      return { timezone: identity.timezone, source: "identity", ...locale };
    }

    const tzPinned = Boolean(identity.overrides?.timezone);
    const tzFromProxyField = !tzPinned && Boolean(proxyTimezone && isValidTimezone(proxyTimezone));
    const needLookup = (!tzPinned && !tzFromProxyField) || !localePinned;
    const cached = needLookup && isFreshProbe(saved?.lastProbe) ? saved!.lastProbe! : null;
    const looked: ProxyExitGeo | null = cached
      ? { timezone: cached.timezone, countryCode: cached.countryCode }
      : needLookup && this.proxyGeoLookup
        ? await this.proxyGeoLookup(proxy).catch(() => null)
        : null;
    if (!cached && saved && looked?.probe) {
      try {
        this.proxyService.recordProbe(saved.id, looked.probe);
      } catch {
        /* best-effort cache write — never a launch failure */
      }
    }

    let tz: { timezone: string | null; source: "pinned" | "proxy" | "exit-ip" | "identity" };
    if (tzPinned) tz = { timezone: identity.timezone, source: "pinned" };
    else if (tzFromProxyField) tz = { timezone: proxyTimezone, source: "proxy" };
    else if (looked?.timezone && isValidTimezone(looked.timezone)) tz = { timezone: looked.timezone, source: "exit-ip" };
    else tz = { timezone: identity.timezone, source: "identity" };

    const exitLocale = localePinned ? null : localeForCountry(looked?.countryCode ?? null);
    return { ...tz, ...(exitLocale ? { locale: exitLocale, localeSource: "exit-ip" as const } : locale) };
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

  /** A run is DEGRADED when its engine process is alive but uncommandable. */
  isDegraded(profileId: string): boolean {
    const run = this.runs.occupyingForProfile(profileId);
    return !!run && this.degradedRuns.has(run.id);
  }

  private ensureLivenessTimer(): void {
    if (this.livenessTimer) return;
    const intervalMs = this.liveness?.intervalMs ?? 20_000;
    this.livenessTimer = setInterval(() => void this.livenessTick(), intervalMs);
    this.livenessTimer.unref?.();
  }

  private clearLivenessState(profileId: string, runId: string): void {
    this.livenessFailures.delete(profileId);
    this.degradedRuns.delete(runId);
    if (this.sessions.size === 0 && this.livenessTimer) {
      clearInterval(this.livenessTimer);
      this.livenessTimer = null;
      this.livenessFailures.clear();
    }
  }

  private async livenessTick(): Promise<void> {
    if (this.sessions.size === 0) {
      if (this.livenessTimer) {
        clearInterval(this.livenessTimer);
        this.livenessTimer = null;
        this.livenessFailures.clear();
      }
      return;
    }
    const threshold = this.liveness?.threshold ?? 3;
    for (const profileId of [...this.sessions.keys()]) {
      const run = this.runs.occupyingForProfile(profileId);
      if (!run?.debugPort) continue;
      const ok = await this.probeEngine(run.debugPort).catch(() => false);
      if (ok) {
        const wasDegraded = this.degradedRuns.has(run.id);
        this.livenessFailures.delete(profileId);
        if (wasDegraded) {
          this.degradedRuns.delete(run.id);
          this.emit({
            type: "run.healthy",
            profileId,
            runId: run.id,
            at: now(),
            detail: "engine responsive again; degraded flag cleared",
          });
        }
        continue;
      }
      const n = (this.livenessFailures.get(profileId) ?? 0) + 1;
      this.livenessFailures.set(profileId, n);
      if (n >= threshold && !this.degradedRuns.has(run.id)) {
        this.degradedRuns.add(run.id);
        this.emit({
          type: "run.degraded",
          profileId,
          runId: run.id,
          at: now(),
          detail:
            `engine unresponsive on 127.0.0.1:${run.debugPort} for ${n} consecutive probes ` +
            "(alive but uncommandable; stop and restart the profile)",
        });
      }
    }
  }

  private async probeEngine(port: number): Promise<boolean> {
    const timeoutMs = this.liveness?.probeTimeoutMs ?? 4_000;
    if (this.liveness?.probe) return this.liveness.probe(port, timeoutMs);
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
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
      this.clearAutoReload(tabId);
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
    const listed = this.tabRegistry.listForRun(run.id);
    return {
      ...listed,
      tabs: listed.tabs.map((t) => {
        const sec = this.autoReloads.get(t.id)?.sec;
        return sec ? { ...t, autoReloadSec: sec } : t;
      }),
    };
  }

  /* --------------------------- tab-ops depth --------------------------- */

  /**
   * An OPEN tab of the profile's active run plus the session that can act on
   * it. Refuses honestly: no run, adopted run (no session), closed tab, or a
   * runtime without the capability.
   */
  private requireTabOp(
    profileId: string,
    tabId: string,
    capability: "reloadTab" | "screenshotTab" | "navigateTab" | "focusTab",
  ): { run: BrowserRun; tab: BrowserTab; session: BrowserSession; engineTabId: string } {
    this.requireProfile(profileId);
    const run = this.runs.occupyingForProfile(profileId);
    if (!run) {
      throw new DomainError(ErrorCodes.PROFILE_NOT_RUNNING, `profile ${profileId} has no active browser run`);
    }
    const tab = this.tabRegistry.getForRun(run.id, tabId);
    if (tab.status !== "open" || !tab.engineTabId) {
      throw new DomainError(ErrorCodes.CONFLICT, `tab ${tabId} is not open`);
    }
    const session = this.sessions.get(profileId);
    if (!session) {
      throw new DomainError(
        ErrorCodes.TABS_UNSUPPORTED,
        `run ${run.id} was adopted after an API restart — its tab state is unknown; stop and relaunch to manage tabs`,
      );
    }
    if (!session[capability]) {
      throw new DomainError(
        ErrorCodes.TABS_UNSUPPORTED,
        `runtime "${this.runtime.kind}" does not implement ${capability}`,
      );
    }
    return { run, tab, session, engineTabId: tab.engineTabId };
  }

  async reloadTab(profileId: string, tabId: string, opts: { hard?: boolean } = {}): Promise<BrowserTab> {
    return this.mutex.runExclusive(profileId, async () => {
      const { tab, session, engineTabId } = this.requireTabOp(profileId, tabId, "reloadTab");
      await session.reloadTab!(engineTabId, opts);
      return tab;
    });
  }

  /** J3b: change a tab's URL (optionally bringing it to the front first). */
  async navigateTab(profileId: string, tabId: string, url: string, opts: { focus?: boolean } = {}): Promise<BrowserTab> {
    return this.mutex.runExclusive(profileId, async () => {
      if (!/^https?:\/\//i.test(url)) throw new DomainError(ErrorCodes.VALIDATION_FAILED, "only http(s) pages can be opened this way");
      const { tab, session, engineTabId } = this.requireTabOp(profileId, tabId, "navigateTab");
      if (opts.focus && session.focusTab) await session.focusTab(engineTabId);
      await session.navigateTab!(engineTabId, url);
      return tab;
    });
  }

  async focusTab(profileId: string, tabId: string): Promise<void> {
    return this.mutex.runExclusive(profileId, async () => {
      const { session, engineTabId } = this.requireTabOp(profileId, tabId, "focusTab");
      await session.focusTab!(engineTabId);
    });
  }

  /** J3b: reopen the most recently closed tab of this run (same URL, a fresh isolated tab). */
  async reopenTab(profileId: string, maxRestorable = 10): Promise<BrowserTab> {
    const run = this.runs.occupyingForProfile(profileId);
    if (!run) throw new DomainError(ErrorCodes.PROFILE_NOT_RUNNING, `profile ${profileId} has no active browser run`);
    const closed = this.tabRegistry
      .listForRun(run.id)
      .tabs.filter((t) => t.status === "closed" && t.url && /^https?:\/\//i.test(t.url))
      .sort((a, b) => (b.closedAt ?? "").localeCompare(a.closedAt ?? ""))
      .slice(0, maxRestorable);
    const last = closed[0];
    if (!last) throw new DomainError(ErrorCodes.CONFLICT, "no closed tab to reopen");
    // A tab is reopened once: the entry is retired so the next reopen goes further back.
    this.tabRegistry.clearReopened(last.id);
    return this.openTab(profileId, { url: last.url });
  }

  async screenshotTab(profileId: string, tabId: string): Promise<Buffer> {
    return this.mutex.runExclusive(profileId, async () => {
      const { session, engineTabId } = this.requireTabOp(profileId, tabId, "screenshotTab");
      return session.screenshotTab!(engineTabId);
    });
  }

  /**
   * Open the tab's URL again as a RELATED tab — same session partition, so
   * the copy shares cookies/storage (Jancy's duplicate). The URL is the one
   * the tab was opened with; in-page navigation since is not tracked.
   */
  async duplicateTab(profileId: string, tabId: string): Promise<BrowserTab> {
    const run = this.runs.occupyingForProfile(profileId);
    if (!run) {
      throw new DomainError(ErrorCodes.PROFILE_NOT_RUNNING, `profile ${profileId} has no active browser run`);
    }
    const tab = this.tabRegistry.getForRun(run.id, tabId);
    if (tab.status !== "open") throw new DomainError(ErrorCodes.CONFLICT, `tab ${tabId} is not open`);
    return this.openTab(profileId, { url: tab.url ?? undefined, relatedTo: tab.id });
  }

  /**
   * Reload a tab every `sec` seconds while it stays open (null/0 = off).
   * In-memory: cleared when the tab closes, the run stops or the engine
   * exits. A failed reload (page gone, engine busy) never stops the timer —
   * the next tick tries again, like a human hitting F5.
   */
  async setAutoReload(profileId: string, tabId: string, sec: number | null): Promise<BrowserTab> {
    return this.mutex.runExclusive(profileId, async () => {
      const { run, tab } = this.requireTabOp(profileId, tabId, "reloadTab");
      this.clearAutoReload(tabId);
      if (sec && sec > 0) {
        const timer = setInterval(() => {
          void this.reloadTab(profileId, tabId).catch(() => {});
        }, sec * this.autoReloadUnitMs);
        timer.unref?.();
        this.autoReloads.set(tabId, { runId: run.id, profileId, sec, timer });
        return { ...tab, autoReloadSec: sec };
      }
      return tab;
    });
  }

  private clearAutoReload(tabId: string): void {
    const entry = this.autoReloads.get(tabId);
    if (entry) clearInterval(entry.timer);
    this.autoReloads.delete(tabId);
  }

  private clearAutoReloadsForRun(runId: string): void {
    for (const [tabId, entry] of this.autoReloads) {
      if (entry.runId === runId) this.clearAutoReload(tabId);
    }
  }

  /**
   * "Applies at next start" check: diff the active run's launch snapshot
   * against the profile's current identity/proxy pointers. Null when the
   * profile has no active run or the run predates snapshots.
   */
  /**
   * Drift + relay state for the console grid in ONE snapshot read — the
   * batch-state endpoint runs this per profile on every SSE event (audit B4
   * removed an N+1 there; two file reads per running profile would bring a
   * smaller one back).
   */
  gridState(profileId: string): {
    drift: IdentityDrift | null;
    relay: "live" | "lost-held" | "lost-unguarded" | null;
  } {
    const run = this.runs.occupyingForProfile(profileId);
    const profile = this.profiles.get(profileId);
    if (!run || !profile || !this.snapshots) return { drift: null, relay: null };
    const snapshot = this.snapshots.forRun(run.id);
    return {
      drift: snapshot
        ? computeIdentityDrift(snapshot, { identityId: profile.identityId, proxyId: profile.proxyId })
        : null,
      relay: this.relayStateFor(profileId, run, snapshot),
    };
  }

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
    /** The browser timezone this run launched with, and where it came from. */
    timezone: string | null;
    timezoneSource: LaunchIdentitySnapshot["timezoneSource"] | null;
    /** The browser locale this run launched with, and where it came from. */
    locale: string | null;
    localeSource: LaunchIdentitySnapshot["localeSource"] | null;
    /**
     * Whether the measured egress still describes where traffic goes:
     * "live" = this API launched the engine and its relay is serving;
     * "lost-held" = adopted after an API restart, the relay died with the old
     * API and its port is held closed (every page fails, nothing leaks);
     * "lost-unguarded" = adopted, and the relay port is owned by another
     * process — traffic may be going through a stranger. null = no proxy.
     */
    relay: "live" | "lost-held" | "lost-unguarded" | null;
    /** Human-readable warning when `egress` no longer reflects reality. */
    note: string | null;
  } | null {
    const run = this.runs.occupyingForProfile(profileId);
    const snapshot = run && this.snapshots ? this.snapshots.forRun(run.id) : null;
    const relay = this.relayStateFor(profileId, run, snapshot);
    const note =
      relay === "lost-held"
        ? "adopted after an API restart: the proxy relay died with the old API, so every request from this browser fails (nothing leaks). The egress below is the launch measurement. Stop and restart the profile to browse again."
        : relay === "lost-unguarded"
          ? "adopted after an API restart: the proxy relay port is owned by another process — this browser's traffic may NOT be going through its proxy. Stop this profile now."
          : null;
    return {
      profileId,
      running: run !== null && run.status === "running",
      engineKind: snapshot?.engineKind ?? this.runtime.kind,
      proxyUrl: redactProxyUrl(snapshot?.proxyUrl ?? null),
      proxySource: snapshot?.proxySource ?? "none",
      egress: snapshot?.egress ?? null,
      timezone: snapshot?.identity?.timezone ?? null,
      timezoneSource: snapshot?.timezoneSource ?? null,
      locale: snapshot?.identity?.locale ?? null,
      localeSource: snapshot?.localeSource ?? null,
      relay,
      note,
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
  reconcileOnBoot(): { adopted: number; crashed: number; unverified: number } {
    let adopted = 0;
    let crashed = 0;
    let unverified = 0;
    const occupying = this.runs.listOccupying();
    // One OS query for every tokened PID, not one blocking spawn per run —
    // this runs before the API opens its port.
    const tokens = captureProcessStartTokens(pidsToVerify(occupying));
    for (const run of occupying) {
      const identity = checkProcessIdentity(run.pid, run.processToken, tokens);
      if (identity === "match" || identity === "unknown") {
        if (run.status !== "running") {
          this.runs.update({ ...run, status: "running" });
        }
        adopted++;
        if (identity === "unknown") {
          // Adopted on liveness alone: the soft-failure bias keeps a healthy
          // session alive, but nothing proved this PID is our engine. Say so
          // — stop() will refuse to kill it by PID.
          unverified++;
          console.warn(
            `[queuepilot] recovery: run ${run.id} (pid ${run.pid}) adopted WITHOUT identity proof — ` +
              (run.processToken ? "start time unreadable" : "no start token on record"),
          );
        }
      } else {
        this.markCrashed(
          run,
          identity === "mismatch"
            ? "engine PID was reused by another process (start token mismatch) at API startup"
            : "engine process not found at API startup",
          "reconciled at boot",
        );
        crashed++;
      }
    }
    this.recoveryCounters.runsAdopted += adopted;
    this.recoveryCounters.runsAdoptedUnverified += unverified;
    this.recoveryCounters.runsReconciledCrashed += crashed;
    if (adopted > 0) this.startAdoptedWatcher();
    return { adopted, crashed, unverified };
  }

  /**
   * Adopted runs have no session, so nothing tells us when their engine
   * exits — without this they would read "running" until the next API boot.
   * One unref'd timer re-checks them; it exists only while adopted runs do.
   */
  private startAdoptedWatcher(): void {
    if (this.adoptedWatcher) return;
    let tick = 0;
    this.adoptedWatcher = setInterval(() => {
      // Liveness is a cheap syscall and runs every tick. Proving identity
      // costs a blocking OS query, so PID reuse is checked every 4th tick.
      this.checkAdoptedRuns(++tick % 4 === 0);
    }, this.adoptedWatchIntervalMs);
    this.adoptedWatcher.unref?.();
  }

  /** Stop watching adopted runs (also self-invoked when none remain). */
  stopAdoptedWatcher(): void {
    if (this.adoptedWatcher) clearInterval(this.adoptedWatcher);
    this.adoptedWatcher = null;
  }

  /**
   * Re-check every sessionless running run against the OS. Dead engines are
   * marked crashed through the same path as boot reconciliation; with
   * `verifyIdentity` a live PID must also still carry our start token (a
   * mismatch means the engine died and a stranger inherited the PID).
   * "unknown" stays adopted — never a guessed death. Returns how many runs
   * were marked crashed.
   */
  checkAdoptedRuns(verifyIdentity = true): number {
    let crashed = 0;
    let watching = 0;
    // Has a session → its exit promise is the watcher. "launching" → a
    // start is in flight and the session is not registered yet.
    const adopted = this.runs
      .listOccupying()
      .filter((run) => run.status === "running" && !this.sessions.has(run.profileId));
    const tokens = verifyIdentity
      ? captureProcessStartTokens(pidsToVerify(adopted))
      : undefined;
    for (const run of adopted) {
      const identity = checkProcessIdentity(
        run.pid,
        verifyIdentity ? run.processToken : null,
        tokens,
      );
      if (identity === "dead" || identity === "mismatch") {
        this.markCrashed(
          run,
          identity === "mismatch"
            ? "adopted engine exited and its PID was reused by another process"
            : "adopted engine process exited",
          "adopted engine gone",
        );
        crashed++;
      } else {
        watching++;
      }
    }
    this.recoveryCounters.runsReconciledCrashed += crashed;
    if (watching === 0) this.stopAdoptedWatcher();
    return crashed;
  }

  /**
   * Hold the dead relay port of every adopted, proxied run (call after
   * reconcileOnBoot, before the API serves). The adopted engine keeps its
   * `--proxy-server` pointing at a port nobody serves any more; holding it
   * keeps the engine failing closed and stops any other process — including
   * a new relay in this API — from receiving that profile's traffic.
   */
  async guardAdoptedRelays(): Promise<{ held: number; unguarded: number }> {
    let held = 0;
    let unguarded = 0;
    for (const run of this.runs.listOccupying()) {
      if (run.status !== "running" || this.sessions.has(run.profileId)) continue;
      if (this.relayHolds.has(run.id)) continue;
      const snapshot = this.snapshots?.forRun(run.id) ?? null;
      const port = snapshot?.proxyUrl ? (snapshot.egress?.relayPort ?? null) : null;
      if (!port) continue;
      const hold = await holdRelayPort(port);
      this.relayHolds.set(run.id, hold);
      if (hold) {
        held++;
      } else {
        unguarded++;
        console.warn(
          `[queuepilot] recovery: run ${run.id} (profile ${run.profileId}) — its proxy relay port ` +
            `${port} is owned by ANOTHER process; this engine's traffic may not go through its proxy. ` +
            "Stop and restart this profile.",
        );
      }
    }
    this.recoveryCounters.relaysHeld += held;
    this.recoveryCounters.relaysUnguarded += unguarded;
    return { held, unguarded };
  }

  /**
   * Proxy-relay state of a run (see egressDiagnostics): null when not
   * running or not proxied. Takes the snapshot so callers read it once.
   */
  private relayStateFor(
    profileId: string,
    run: BrowserRun | null,
    snapshot: LaunchIdentitySnapshot | null,
  ): "live" | "lost-held" | "lost-unguarded" | null {
    if (!run || !snapshot?.proxyUrl || !snapshot.egress?.relayPort) return null;
    if (this.sessions.has(profileId)) return "live";
    return this.relayHolds.get(run.id) ? "lost-held" : "lost-unguarded";
  }

  private releaseRelayHold(runId: string): void {
    const hold = this.relayHolds.get(runId);
    this.relayHolds.delete(runId);
    void hold?.close();
  }

  /** A run whose engine is gone without the API seeing its exit. */
  private markCrashed(run: BrowserRun, lastError: string, detail: string): void {
    this.releaseRelayHold(run.id);
    // Unreachable today (crash marking is sessionless, auto-reload needs a
    // session) — kept so every run-ending path clears both kinds of state.
    this.clearAutoReloadsForRun(run.id);
    this.runs.update({ ...run, status: "crashed", stoppedAt: now(), lastError });
    const profile = this.profiles.get(run.profileId);
    if (profile) this.markProfile(profile, "idle");
    this.emit({
      type: "run.crashed",
      profileId: run.profileId,
      runId: run.id,
      at: now(),
      detail,
    });
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
    this.clearLivenessState(profileId, runId);
    this.clearAutoReloadsForRun(runId);
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
    // Re-read the row: `profile` may be the copy loaded at launch start, and
    // writing it back would wipe anything changed since (a P-LOCK pin, a
    // persona edit made while the profile ran). Only `status` is ours here.
    const fresh = this.profiles.get(profile.id) ?? profile;
    this.profiles.update({ ...fresh, status, updatedAt: now() });
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

/** PIDs whose identity can be proven: the run has both a PID and a token. */
function pidsToVerify(runs: readonly BrowserRun[]): number[] {
  return runs.flatMap((r) => (r.pid && r.processToken ? [r.pid] : []));
}

/** A proxy endpoint as the launch resolved it (password included, in memory only). */
export interface LaunchProxyEndpoint {
  type: "http" | "https" | "socks5";
  host: string;
  port: number;
  username: string | null;
  password: string | null;
}

/** What the exit lookup reports about a proxy's exit IP. */
export interface ProxyExitGeo {
  timezone: string | null;
  /** ISO 3166-1 alpha-2, e.g. "DE". */
  countryCode: string | null;
  /** The full probe, when the lookup has one — stored back on a saved proxy. */
  probe?: ProxyProbe;
}

/**
 * The likely locale for a country (DE → de-DE, GB → en-GB, CH → de-CH), from
 * CLDR likely-subtags via Intl.Locale#maximize — no table to maintain. Null
 * for anything that is not a two-letter region the runtime recognises.
 */
export function localeForCountry(countryCode: string | null): string | null {
  if (!countryCode || !/^[A-Za-z]{2}$/.test(countryCode)) return null;
  try {
    const max = new Intl.Locale(`und-${countryCode.toUpperCase()}`).maximize();
    if (!max.language || max.language === "und" || !max.region) return null;
    return `${max.language}-${max.region}`;
  } catch {
    return null;
  }
}

/** True for an IANA zone this runtime knows (rejects garbage from a geo service). */
function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * The machine's own IANA timezone (what a direct — no-proxy — connection
 * presents). Node ships full ICU, so this resolves everywhere we run; a
 * stripped runtime returns null and the caller falls back to the identity
 * default. Injectable on the lifecycle (like proxyGeoLookup) so tests
 * are machine-independent.
 */
export function systemHostTimezone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? null;
  } catch {
    return null;
  }
}

function now(): string {
  return new Date().toISOString();
}
