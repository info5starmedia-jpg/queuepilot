import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  DomainError,
  ErrorCodes,
  InstalledEngineSchema,
  type FingerprintIdentity,
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
import {
  claimedScreenArea,
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
 * spawn goes through a short PowerShell bootstrap (-EncodedCommand, no file
 * on disk): .NET file handles are inheritable by default and Process.Start
 * always passes bInheritHandles=TRUE. The bootstrap prints the engine PID and
 * exits with the engine's exit code, so process supervision stays ours.
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

    const fitArea = claimedScreenArea(request.identity);
    const initialSize = initialWindowSize(request.identity);
    const engineArgs = [
      `--user-data-dir=${request.profileDataDir}`,
      `--remote-debugging-port=${debugPort}`,
      "--no-first-run",
      "--no-default-browser-check",
      `--window-size=${initialSize.width},${initialSize.height}`,
      ...(relay ? [`--proxy-server=http://127.0.0.1:${relay.port}`] : []),
      "about:blank",
    ];

    // Named launch refusals (AliasMode discipline): every failure says WHICH
    // stage refused — process_spawn, config_handoff, engine_start — never a
    // bare "launch failed" the operator has to guess at.
    let child: ChildProcess;
    try {
      child = spawnFuryWithConfig(binary, configPath, oscryptKeyPath, engineArgs);
    } catch (err) {
      if (relay) await relay.close().catch(() => {});
      throw new DomainError(
        ErrorCodes.ENGINE_LAUNCH_FAILED,
        `process_spawn: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    let enginePid: number;
    try {
      enginePid = await readEnginePid(child);
    } catch (err) {
      if (relay) await relay.close().catch(() => {});
      throw err instanceof DomainError
        ? err
        : new DomainError(
            ErrorCodes.ENGINE_LAUNCH_FAILED,
            `engine_start: ${err instanceof Error ? err.message : String(err)}`,
          );
    }
    return new FurySession(child, enginePid, debugPort, relay, fitArea, egress);
  }
}

/**
 * Map a QueuePilot identity onto the fury persona schema (v1). Absent keys
 * mean "use the real value" — we only declare what our identity model owns.
 * Noise seeds derive deterministically from the identity seed so a profile's
 * canvas/audio/rects are stable across machines and restarts.
 */
export function personaConfig(
  identity: FingerprintIdentity | null,
): Record<string, unknown> {
  if (!identity) return { schema_version: 1 };
  const seed = identity.seed % 2_147_483_647;
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
    },
    screen: {
      width: identity.screenWidth,
      height: identity.screenHeight,
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
): ChildProcess {
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
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
}

/** First stdout line from the bootstrap is "QPID:<engine pid>". */
function readEnginePid(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(
      () => reject(new Error("fury bootstrap did not report an engine PID")),
      20_000,
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
      const conn = await CdpConnection.connect(this.wsEndpoint, 10_000);
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
