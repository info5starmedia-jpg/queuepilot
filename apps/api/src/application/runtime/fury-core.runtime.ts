import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DomainError,
  ErrorCodes,
  InstalledEngineSchema,
  type FingerprintIdentity,
  type FingerprintIdentityWithOverrides,
  type ObservedFingerprint,
} from "@queuepilot/contracts";
import type {
  BrowserRuntime,
  BrowserSession,
  EgressInfo,
  LaunchRequest,
  OpenTabRequest,
} from "./browser-runtime.js";
import { CdpTabController } from "./cdp/cdp-tab-controller.js";
import { CdpConnection } from "./cdp/cdp-connection.js";
import { captureFingerprintViaDebugPort } from "./cdp/cdp-attestation.js";
import { startProxyRelay, type ProxyRelay } from "./proxy-relay.js";
import { egressIpViaRelay } from "./egress-check.js";
import { getOrCreateOscryptKey } from "./oscrypt-key.js";
import { applyBookmarkSets, normalizeBookmarkSets } from "./bookmark-sets.js";
import { cleanProfileDirStaleness } from "./profile-hygiene.js";
import {
  claimedAvailArea,
  cdpWindowDriver,
  initialWindowSize,
  WindowFitWatcher,
  type ScreenArea,
} from "./window-fit.js";

/**
 * Fury core engine adapter — Fury's BSD-3-Clause patched Chromium
 * (components/fury: canvas/audio/client-rects noise, WebGL/WebGPU, fonts,
 * timezone, mobile persona, all at C++ level), distributed as prebuilt cores
 * through our checksummed, consent-gated EngineInstaller.
 *
 * LAUNCH CONTRACT (implemented from the BSD patch sources, never from Fury's
 * AGPL agent): the persona is JSON handed to the browser as an ALREADY-OPEN
 * file — a descriptor on POSIX, an inherited HANDLE on Windows — and only the
 * handle number travels in argv (`--fury-fp-file-handle=<uint32>`), because a
 * command line containing the whole persona would leak it to any local
 * observer. The browser refuses to start on an unparseable config rather than
 * run half-configured. Our attestation endpoint then proves the persona
 * materialized — the spike's acceptance gate. The same HANDLE contract
 * carries the per-profile os-crypt key (0110,
 * `--fury-oscrypt-file-handle=<uint32>`); unlike the config, a missing key
 * degrades to the machine key, never a refusal.
 *
 * Node cannot mint an inheritable HANDLE or read its raw value, so the actual
 * spawn goes through a short PowerShell bootstrap written to a temp .ps1 and
 * run with -File (-EncodedCommand gets the engine killed by endpoint AV;
 * measured 2026-11-14, see spawnFuryWithConfig): .NET file handles are
 * inheritable by default and Process.Start always passes bInheritHandles=TRUE.
 * The bootstrap prints the engine PID and exits with the engine's exit code,
 * so process supervision stays ours.
 */
export class FuryCoreRuntime implements BrowserRuntime {
  readonly kind = "fury";

  /**
   * The binary path is resolved ONCE at construction: env override, else the
   * newest verified install receipt under <dataDir>/engines/fury-core/.
   */
  constructor(private readonly binaryPath: string | null) {}

  engineBinaryPath(): string | null {
    return this.binaryPath;
  }

  async launch(request: LaunchRequest): Promise<BrowserSession> {
    const binary = this.binaryPath;
    if (!binary || !fs.existsSync(binary)) {
      throw new DomainError(
        ErrorCodes.ENGINE_UNAVAILABLE,
        `Fury core not installed. Install it: queuepilot engine install --manifest <file> --yes (or set SPECTRA_FURY_PATH).`,
      );
    }
    fs.mkdirSync(request.profileDataDir, { recursive: true });

    // Start pages on EVERY launch (Fury 0.5.2 parity): the engine opens the
    // profile's start URLs each start, not just the first. extra.url is the
    // Jancy URL column (single); extra.startUrls is the array form.
    const startUrls = startUrlsOf(request.profile);
    // Bookmark sets (Fury 0.5.3 parity), runtime-side: merged into Chromium's
    // own Bookmarks file before launch; browser-made bookmarks untouched.
    const bookmarkSets = normalizeBookmarkSets(request.profile.extra?.bookmarkSets);
    if (bookmarkSets.length > 0) {
      applyBookmarkSets(request.profileDataDir, bookmarkSets);
    }
    // P5.6 hygiene: a previous HARD kill leaves singleton state behind. Safe
    // to remove here because the lifecycle layer only calls launch after the
    // per-profile guard proved no live engine occupies this profile.
    cleanProfileDirStaleness(request.profileDataDir);

    const debugPort = await findFreePort();
    const config = personaConfig(request.identity);

    // P0 (proxy leak): a configured proxy is NEVER silently dropped. The
    // engine only understands --proxy-server without credentials, so an
    // auth-injecting loopback relay fronts the real upstream. A proxy the
    // relay cannot honor (socks5, unparseable) refuses the launch loudly —
    // direct fallback would leak the operator's real IP, which is the one
    // failure this product may never have.
    let relay: ProxyRelay | null = null;
    let egress: EgressInfo | null = null;
    if (request.proxyUrl) {
      relay = await startProxyRelay(request.proxyUrl);

      // Patch 0071: give the engine the launch's exit address so its WebRTC
      // allocator can announce Chrome's candidate shape (mDNS host + srflx
      // through that address) instead of "WebRTC disabled". Fresh check per
      // launch — a stale address from a rotating proxy would contradict what
      // sites see. Soft failure: no keys, engine gathers nothing (0.5.1
      // behavior), never a guessed address.
      const exitIp = await egressIpViaRelay(relay.port).catch(() => null);
      const webrtcPublicIp = exitIp;
      const webrtcHostName = exitIp ? `${crypto.randomUUID()}.local` : null;
      if (exitIp) {
        config.webrtc = {
          ...(config.webrtc as Record<string, unknown>),
          publicIp: exitIp,
          hostName: webrtcHostName,
        };
      }
      // Diagnostics surface (P7): what the launch measured, verbatim. The
      // diagnostics endpoint serves exactly this — never a re-check, which
      // would race a rotating proxy.
      egress = {
        relayPort: relay.port,
        exitIp,
        webrtcPublicIp,
        webrtcHostName,
        checkedAt: new Date().toISOString(),
      };
    }

    const configPath = path.join(request.profileDataDir, "fury-config.json");
    fs.writeFileSync(configPath, JSON.stringify(config));

    // Parity 0110: per-profile os-crypt key so cookies/passwords encrypt at
    // rest under a key that travels with the profile. Missing key is NOT
    // fatal (engine falls back to the machine key) — but a profile we own
    // always has one.
    const oscryptKeyPath = getOrCreateOscryptKey(request.profileDataDir);

    // The hard invariant is window <= claimed WORKAREA: a page compares
    // outerHeight against screen.availHeight, not screen.height.
    const fitArea = claimedAvailArea(request.identity);
    const initialSize = initialWindowSize(request.identity);
    const engineArgs = [
      `--user-data-dir=${request.profileDataDir}`,
      `--remote-debugging-port=${debugPort}`,
      "--no-first-run",
      "--no-default-browser-check",
      `--window-size=${initialSize.width},${initialSize.height}`,
      ...(relay ? [`--proxy-server=http://127.0.0.1:${relay.port}`] : []),
      ...ENGINE_FEATURE_SWITCHES,
      ...startUrls,
    ];

    // Named launch refusals (AliasMode discipline): every failure says WHICH
    // stage refused — process_spawn, config_handoff, engine_start — never a
    // bare "launch failed" the operator has to guess at.
    let child: ChildProcess;
    let bootstrapScript: string;
    try {
      ({ child, scriptPath: bootstrapScript } = spawnFuryWithConfig(
        binary,
        configPath,
        oscryptKeyPath,
        engineArgs,
      ));
    } catch (err) {
      if (relay) await relay.close().catch(() => {});
      throw new DomainError(
        ErrorCodes.ENGINE_LAUNCH_FAILED,
        `process_spawn: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // The bootstrap script file is removed as soon as the bootstrap exits
    // (it cannot be deleted earlier: PowerShell reads the script file
    // incrementally while it runs).
    child.once("exit", () => {
      fs.rm(bootstrapScript, { force: true }, () => {});
    });
    let enginePid: number;
    try {
      enginePid = await readEnginePid(child);
    } catch (err) {
      child.removeAllListeners("exit");
      fs.rmSync(bootstrapScript, { force: true });
      if (relay) await relay.close().catch(() => {});
      throw err instanceof DomainError
        ? err
        : new DomainError(
            ErrorCodes.ENGINE_LAUNCH_FAILED,
            `engine_start: ${err instanceof Error ? err.message : String(err)}`,
          );
    }
    // CDP readiness (AliasMode discipline): the bootstrap PID proves the
    // process started, not that the DevTools endpoint answers. A launch whose
    // endpoint never comes up is refused and NAMED now — "cdp_readiness" —
    // instead of a profile that looks running but answers nothing.
    try {
      // 60 s, not 15: on AV-heavy hosts (Norton scanning a fresh Chromium
      // spawn) the DevTools endpoint can take tens of seconds on a COLD
      // profile. A genuinely dead engine still fails — just named later.
      await waitForCdpReady(debugPort, 60_000);
    } catch (err) {
      child.removeAllListeners("exit");
      child.kill();
      fs.rmSync(bootstrapScript, { force: true });
      if (relay) await relay.close().catch(() => {});
      throw new DomainError(
        ErrorCodes.ENGINE_LAUNCH_FAILED,
        `cdp_readiness: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return new FurySession(child, enginePid, debugPort, relay, fitArea, egress);
  }
}

/**
 * Chromium feature switches on every launch. Chromium honors only the LAST
 * --disable-features on a command line, so every disabled feature goes in
 * this one switch, never a second one.
 * - DnsOverHttpsUpgrade: Secure DNS "automatic" mode silently upgrades a
 *   host resolver it recognizes (1.1.1.1, 8.8.8.8, ...) to DoH. A proxied
 *   page never resolves locally, but the browser's own lookups would then
 *   reach a public DoH provider from the host's real IP.
 */
export const ENGINE_FEATURE_SWITCHES = ["--disable-features=DnsOverHttpsUpgrade"] as const;

/**
 * Start URLs for a launch, from the profile's extra bag: `startUrls` (array)
 * wins; Jancy's single `url` column is the fallback. Only http/https pass;
 * anything else is dropped (a bad URL must never become a launch arg), and
 * an empty result means the engine opens its default about:blank.
 */
export function startUrlsOf(profile: {
  extra: Record<string, unknown> | null;
}): string[] {
  const extra = profile.extra ?? {};
  const raw =
    Array.isArray(extra.startUrls) && extra.startUrls.length > 0
      ? extra.startUrls
      : typeof extra.url === "string" && extra.url.trim() !== ""
        ? [extra.url]
        : [];
  const urls: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    try {
      const u = new URL(item.trim());
      if (u.protocol === "http:" || u.protocol === "https:") urls.push(item.trim());
    } catch {
      // Not a URL — never lands in argv.
    }
  }
  return urls.length > 0 ? urls : ["about:blank"];
}

/**
 * Map a QueuePilot identity onto the fury persona schema (v1). Absent keys
 * mean "use the real value" — we only declare what our identity model owns.
 * Noise seeds derive deterministically from the identity seed so a profile's
 * canvas/audio/rects are stable across machines and restarts.
 *
 * v0.16.0: engine-level pins ride the same contract — the fury patchset
 * reads navigator.userAgent (0011), fonts/fontsHidden (0050-0052) and
 * gpu.webglParams.UNMASKED_* (0031) straight from this config, so a pinned
 * UA/font-list/WebGL pair reaches the C++ layer verbatim.
 */
export function personaConfig(
  identity: FingerprintIdentityWithOverrides | null,
): Record<string, unknown> {
  if (!identity) return { schema_version: 1 };
  const seed = identity.seed % 2_147_483_647;
  const webglParams: Record<string, string> = {};
  if (identity.webglVendor) webglParams.UNMASKED_VENDOR_WEBGL = identity.webglVendor;
  if (identity.webglRenderer) webglParams.UNMASKED_RENDERER_WEBGL = identity.webglRenderer;
  return {
    schema_version: 1,
    navigator: {
      hardwareConcurrency: identity.hardwareConcurrency,
      deviceMemory: identity.deviceMemoryGb,
      platform:
        identity.platform === "windows"
          ? "Win32"
          : identity.platform === "macos"
            ? "MacIntel"
            : "Linux x86_64",
      // Pin-only keys: absent unless the operator pinned them.
      ...(identity.userAgent ? { userAgent: identity.userAgent } : {}),
    },
    screen: {
      width: identity.screenWidth,
      height: identity.screenHeight,
      // Patch 0020 reads availWidth/availHeight independently; without these
      // keys the HOST's workarea leaks through, and a persona screen smaller
      // than the host display reads avail > screen — a contradiction no real
      // display produces (sannysoft PHANTOM_WINDOW_HEIGHT flags it; measured
      // 2026-11-14). A bottom taskbar of 48 px at 1x scale is the standard
      // Windows shape: availWidth == width, availHeight == height - 48, and
      // when the persona matches the host display this exactly equals the
      // host's real workarea.
      availWidth: identity.screenWidth,
      availHeight: Math.max(identity.screenHeight - 48, Math.floor(identity.screenHeight * 0.9)),
      availLeft: 0,
      availTop: 0,
      colorDepth: 24,
      devicePixelRatio: 1,
    },
    locale: {
      timezone: identity.timezone,
      locale: identity.locale,
    },
    noise: {
      canvasSeed: seed,
      audioSeed: (seed * 2 + 1) % 2_147_483_647,
      clientRectsSeed: (seed * 3 + 2) % 2_147_483_647,
    },
    automation: { hideTraces: true },
    // Patch 0121: our personas are desktops on mains. Without these keys the
    // engine passes the HOST's battery tuple through — a laptop host (or a
    // UPS at 0.98) leaks. dischargingTime -1 is the patch's Infinity sentinel.
    battery: {
      charging: true,
      level: 1.0,
      chargingTime: 0,
      dischargingTime: -1,
    },
    // Patch 0070: the enterprise policy shape — mDNS host candidate only,
    // never the machine's real IP. The M150 switch is read nowhere in
    // //chrome; only the preference (which this config sets) works.
    webrtc: { ipHandlingPolicy: "disable_non_proxied_udp" },
    // v0.16.0 engine-level pins (absent unless pinned — the engine then
    // keeps its real/derived values, per the absent-keys contract).
    ...(Object.keys(webglParams).length > 0 ? { "gpu.webglParams": webglParams } : {}),
    ...(identity.fonts ? { fonts: identity.fonts } : {}),
    ...(identity.fontsHidden ? { fontsHidden: identity.fontsHidden } : {}),
  };
}

/** Newest verified fury-core install under <dataDir>/engines/fury-core/. */
export function resolveFuryBinary(dataDir: string): string | null {
  if (process.env.SPECTRA_FURY_PATH) return process.env.SPECTRA_FURY_PATH;
  const root = path.join(dataDir, "engines", "fury-core");
  if (!fs.existsSync(root)) return null;
  const receipts: {
    dir: string;
    binaryPath?: string | undefined;
    installedAt: string;
  }[] = [];
  for (const version of fs.readdirSync(root)) {
    const vdir = path.join(root, version);
    if (!fs.statSync(vdir).isDirectory()) continue;
    for (const platform of fs.readdirSync(vdir)) {
      const receiptFile = path.join(vdir, platform, "install.json");
      if (!fs.existsSync(receiptFile)) continue;
      try {
        receipts.push(
          InstalledEngineSchema.parse(
            JSON.parse(fs.readFileSync(receiptFile, "utf8")),
          ),
        );
      } catch {
        // corrupt receipt — not an install
      }
    }
  }
  receipts.sort((a, b) => b.installedAt.localeCompare(a.installedAt));
  const newest = receipts[0];
  if (!newest?.binaryPath) return null;
  const exe = path.join(newest.dir, newest.binaryPath);
  return fs.existsSync(exe) ? exe : null;
}

/* ------------------------------------------------------------------ */
/* Windows spawn bootstrap: config file -> inherited HANDLE -> engine. */
/* ------------------------------------------------------------------ */

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Quote one argv entry for ProcessStartInfo.Arguments (CommandLineToArgvW
 * rules): wrap in double quotes, double up literal backslashes that precede a
 * quote, escape literal quotes.
 */
function argvQuote(value: string): string {
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}

/**
 * Spawn the engine through the PowerShell bootstrap, handing over TWO
 * inherited HANDLEs: the persona config (0001) and the per-profile os-crypt
 * key (0110). Node cannot mint inheritable HANDLEs itself; .NET file handles
 * are made inheritable with SetHandleInformation and only the handle numbers
 * travel in argv — never the contents.
 */
function spawnFuryWithConfig(
  binary: string,
  configPath: string,
  oscryptKeyPath: string,
  engineArgs: string[],
): { child: ChildProcess; scriptPath: string } {
  const argLine = engineArgs.map(argvQuote).join(" ");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    // .NET file handles are NOT inheritable by default here (measured:
    // GetHandleInformation returns flags=0), and without HANDLE_FLAG_INHERIT
    // the child gets ERROR_INVALID_HANDLE and Fury refuses to start.
    `Add-Type -MemberDefinition '[DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetHandleInformation(System.IntPtr h, uint mask, uint flags);' -Name 'K32' -Namespace 'QueuePilotLaunch'`,
    `$fs = [System.IO.File]::Open(${psQuote(configPath)}, 'Open', 'Read', 'ReadWrite')`,
    "$raw = $fs.SafeFileHandle.DangerousGetHandle()",
    "[void][QueuePilotLaunch.K32]::SetHandleInformation($raw, 1, 1)",
    // Windows guarantees HANDLEs fit in 32 bits (WOW64 interop); IntPtr has
    // no ToUInt32 on PowerShell 5.1, so mask the Int64.
    "$h = [uint32]($raw.ToInt64() -band 0xFFFFFFFF)",
    `$ks = [System.IO.File]::Open(${psQuote(oscryptKeyPath)}, 'Open', 'Read', 'ReadWrite')`,
    "$kraw = $ks.SafeFileHandle.DangerousGetHandle()",
    "[void][QueuePilotLaunch.K32]::SetHandleInformation($kraw, 1, 1)",
    "$kh = [uint32]($kraw.ToInt64() -band 0xFFFFFFFF)",
    "$psi = New-Object System.Diagnostics.ProcessStartInfo",
    `$psi.FileName = ${psQuote(binary)}`,
    `$psi.Arguments = "--fury-fp-file-handle=$h --fury-oscrypt-file-handle=$kh " + ${psQuote(argLine)}`,
    "$psi.UseShellExecute = $false",
    "$p = [System.Diagnostics.Process]::Start($psi)",
    "Write-Output (\"QPID:\" + $p.Id)",
    "$p.WaitForExit()",
    "$fs.Close()",
    "$ks.Close()",
    "exit $p.ExitCode",
  ].join("\n");
  // MEASURED 2026-11-14: -EncodedCommand gets the ENGINE killed ~10s after
  // launch. Bisected live: identical bootstrap via -File survives; via
  // -EncodedCommand the engine is TerminateProcess'd (exit 0, no shutdown
  // logging) ~10s in — endpoint AV (Norton active on this class of machine)
  // treats powershell -EncodedCommand spawning a browser as a malware
  // pattern. The script contains nothing secret (no credentials; handle
  // NUMBERS travel in argv, never contents), so a short-lived temp file is
  // the honest price of a launch the operator's AV permits. BOM: PS 5.1
  // misreads UTF-8-no-BOM scripts as ANSI, mangling quoted paths.
  const scriptPath = path.join(
    os.tmpdir(),
    `queuepilot-launch-${crypto.randomUUID()}.ps1`,
  );
  fs.writeFileSync(scriptPath, `\ufeff${script}`);
  try {
    return {
      child: spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
        { stdio: ["ignore", "pipe", "pipe"] },
      ),
      scriptPath,
    };
  } catch (err) {
    fs.rmSync(scriptPath, { force: true });
    throw err;
  }
}

/** First stdout line from the bootstrap is "QPID:<engine pid>". */
/**
 * Poll the DevTools endpoint until it answers. Named separately so a launch
 * failure can say "cdp_readiness" (AliasMode's named-refusal discipline) and
 * so tests can drive it against a real loopback server.
 */
export async function waitForCdpReady(
  debugPort: number,
  timeoutMs = 15_000,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no response";
  for (;;) {
    try {
      const res = await fetchImpl(`http://127.0.0.1:${debugPort}/json/version`);
      if (res.ok) return;
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `DevTools endpoint did not answer within ${timeoutMs}ms (${lastError})`,
      );
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

function readEnginePid(child: ChildProcess): Promise<number> {  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(
      // 60 s, not 20: AV scanners (Norton on this class of host) can hold the
      // PowerShell bootstrap well past 20 s on a cold machine. The QPID line
      // is still the only success path — this just stops punishing slow scans.
      () => reject(new Error("fury bootstrap did not report an engine PID")),
      60_000,
    );
    let stderr = "";
    child.stderr?.on("data", (d) => (stderr += String(d)));
    child.stdout?.on("data", (d) => {
      buf += String(d);
      const m = buf.match(/QPID:(\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(
        new Error(
          `fury bootstrap exited (code ${code}) before launch: ${stderr.slice(0, 500)}`,
        ),
      );
    });
    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

export class FurySession implements BrowserSession {
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
  readonly wsEndpoint: string;
  private readonly tabs: CdpTabController;

  constructor(
    /** The PowerShell bootstrap process; exits with the engine's exit code. */
    private readonly bootstrap: ChildProcess,
    /** The actual engine PID (child of the bootstrap). */
    readonly enginePid: number,
    readonly debugPort: number,
    /** Auth-injecting relay for this run, when a proxy is configured. */
    private readonly relay: ProxyRelay | null = null,
    /** Claimed screen area the window-fit watcher enforces; null disables it. */
    fitArea: ScreenArea | null = null,
    /** Egress facts measured at launch; null when launched without a proxy. */
    readonly egress: EgressInfo | null = null,
  ) {
    this.wsEndpoint = `ws://127.0.0.1:${debugPort}`;
    this.tabs = new CdpTabController(this.wsEndpoint, async () => {
      const res = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
      if (res.ok) {
        const info = (await res.json()) as { webSocketDebuggerUrl?: string };
        if (info.webSocketDebuggerUrl) return info.webSocketDebuggerUrl;
      }
      return this.wsEndpoint;
    });
    this.exited = new Promise((resolve) => {
      bootstrap.once("exit", (code, signal) => resolve({ code, signal }));
    });
    // The relay lives exactly as long as the engine: a window-closed exit
    // must not leave a listener holding proxy credentials behind.
    this.exited.then(() => relay?.close().catch(() => {}));
    // Window fit (AliasMode discipline): a window may never exceed the
    // claimed screen, or a page finds innerHeight > screen.height in one
    // comparison. The watcher is best-effort at launch — a failure here
    // degrades stealth, never launch, and is logged.
    if (fitArea) {
      this.windowFit = { area: fitArea, watcher: null };
      void this.startWindowFit();
    }
  }

  private windowFit: { area: ScreenArea; watcher: WindowFitWatcher | null } | null =
    null;

  private async startWindowFit(): Promise<void> {
    const fit = this.windowFit;
    if (!fit || fit.watcher) return;
    try {
      // The bare ws://host:port root is not a valid CDP upgrade path; resolve
      // the real browser-target URL from /json/version first.
      let wsUrl = this.wsEndpoint;
      for (let attempt = 0; attempt < 20; attempt++) {
        try {
          const res = await fetch(`http://127.0.0.1:${this.debugPort}/json/version`);
          if (res.ok) {
            const info = (await res.json()) as { webSocketDebuggerUrl?: string };
            if (info.webSocketDebuggerUrl) {
              wsUrl = info.webSocketDebuggerUrl;
              break;
            }
          }
        } catch {
          /* debug endpoint not up yet */
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      const conn = await CdpConnection.connect(wsUrl, 10_000);
      this.exited.then(() => conn.close());
      const watcher = new WindowFitWatcher(cdpWindowDriver(conn), fit.area, {
        log: (msg) => console.warn(`[fury] ${msg}`),
      });
      fit.watcher = watcher;
      watcher.start();
    } catch (err) {
      console.warn(`[fury] window-fit watcher unavailable: ${String(err)}`);
    }
  }

  /** BrowserSession.pid is the engine PID, not the bootstrap's. */
  get pid(): number {
    return this.enginePid;
  }

  async openTab(request: OpenTabRequest): Promise<{ engineTabId: string }> {
    return this.tabs.openTab(request.url, request.partitionKey);
  }

  async closeTab(engineTabId: string): Promise<void> {
    return this.tabs.closeTab(engineTabId);
  }

  async reloadTab(engineTabId: string): Promise<void> {
    return this.tabs.reloadTab(engineTabId);
  }

  async screenshotTab(engineTabId: string): Promise<Buffer> {
    return this.tabs.screenshotTab(engineTabId);
  }

  async captureFingerprint(): Promise<ObservedFingerprint> {
    return captureFingerprintViaDebugPort("fury", this.debugPort, this.wsEndpoint);
  }

  async stop(): Promise<void> {
    if (this.bootstrap.exitCode !== null || this.bootstrap.killed) return;
    this.windowFit?.watcher?.stop();
    await this.tabs.dispose();
    // Graceful first: taskkill without /F posts WM_CLOSE, which Chromium
    // handles as a clean shutdown (session store written, code 0).
    await taskkill(this.enginePid, false);
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("engine stop timeout")), 10_000),
    );
    try {
      await Promise.race([this.exited, timeout]);
    } catch {
      await taskkill(this.enginePid, true);
      await this.exited;
    } finally {
      if (this.relay) await this.relay.close().catch(() => {});
    }
  }
}

function taskkill(pid: number, force: boolean): Promise<void> {
  return new Promise((resolve) => {
    const args = ["/PID", String(pid), "/T"];
    if (force) args.push("/F");
    const p = spawn("taskkill", args, { stdio: "ignore" });
    p.once("exit", () => resolve());
    p.once("error", () => resolve());
  });
}

/** Ask the OS for a free port by binding :0 and releasing it. */
async function findFreePort(): Promise<number> {
  const net = await import("node:net");
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("no port")));
      }
    });
  });
}
