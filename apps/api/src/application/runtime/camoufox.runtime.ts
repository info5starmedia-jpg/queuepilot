import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DomainError, ErrorCodes, type ObservedFingerprint } from "@queuepilot/contracts";
import type {
  BrowserRuntime,
  BrowserSession,
  LaunchRequest,
  OpenTabRequest,
} from "./browser-runtime.js";
import { CdpTabController } from "./cdp/cdp-tab-controller.js";
import { captureFingerprintViaDebugPort } from "./cdp/cdp-attestation.js";

/**
 * Camoufox engine adapter.
 *
 * Camoufox is a C++-patched Firefox — fingerprint spoofing below the JS
 * layer — and the only serious open engine that doesn't require us to fork a
 * browser on day one. The adapter launches the Camoufox binary directly
 * (persistent profile dir per QueuePilot profile) with a debug port, the same
 * way the big commercial tools drive their cores.
 *
 * The engine binary is NOT bundled or auto-downloaded (ADR-0003): set
 * SPECTRA_CAMOUFOX_PATH or drop the binary at <dataDir>/engines/camoufox/.
 * Nothing in the API silently downloads code from the internet.
 *
 * Isolation per profile: camoufox supports fingerprint config via env var
 * CAMOU_CONFIG as JSON; we pass the QueuePilot identity through it.
 */
export class CamoufoxRuntime implements BrowserRuntime {
  readonly kind = "camoufox";

  /**
   * The binary path is resolved ONCE at construction (env override or
   * <dataDir>/engines/camoufox/) — it must not depend on the per-launch
   * request, because profileDataDir is per-profile and the engine is shared.
   */
  constructor(private readonly binaryPath: string) {}

  engineBinaryPath(): string {
    return this.binaryPath;
  }

  async launch(request: LaunchRequest): Promise<BrowserSession> {
    const binary = this.binaryPath;
    if (!fs.existsSync(binary)) {
      throw new DomainError(
        ErrorCodes.ENGINE_UNAVAILABLE,
        `Camoufox binary not found at ${binary}. Install it or set SPECTRA_CAMOUFOX_PATH.`,
      );
    }
    fs.mkdirSync(request.profileDataDir, { recursive: true });

    const debugPort = await findFreePort();
    const args = [
      "-profile",
      request.profileDataDir,
      "-no-remote",
      "--remote-debugging-port",
      String(debugPort),
      "-width",
      String(request.identity?.screenWidth ?? 1920),
      "-height",
      String(request.identity?.screenHeight ?? 1080),
    ];

    const env: NodeJS.ProcessEnv = { ...process.env };
    if (request.proxyUrl) {
      // Firefox-family engines take proxy via config, not a CLI flag; the
      // Camoufox config JSON carries it into the profile.
    }
    env.CAMOU_CONFIG = JSON.stringify({
      ...(request.identity
        ? {
            "navigator.userAgent": undefined,
            screenWidth: request.identity.screenWidth,
            screenHeight: request.identity.screenHeight,
            hardwareConcurrency: request.identity.hardwareConcurrency,
            deviceMemory: request.identity.deviceMemoryGb,
            timezone: request.identity.timezone,
            locale: request.identity.locale,
            seed: request.identity.seed,
          }
        : {}),
      ...(request.proxyUrl ? { proxy: request.proxyUrl } : {}),
    });

    const child = spawn(binary, args, {
      env,
      stdio: ["ignore", "ignore", "pipe"],
      detached: false,
    });
    return new CamoufoxSession(child, debugPort);
  }
}

export class CamoufoxSession implements BrowserSession {
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
  readonly wsEndpoint: string;
  /**
   * Engine-side tab routing. The browser-level debugger URL is discovered
   * from /json/version (it carries a session path); the bare ws://host:port
   * is only the fallback.
   */
  private readonly tabs: CdpTabController;

  constructor(
    private readonly child: ChildProcess,
    readonly debugPort: number,
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
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
  }

  get pid(): number {
    return this.child.pid ?? -1;
  }

  async openTab(request: OpenTabRequest): Promise<{ engineTabId: string }> {
    return this.tabs.openTab(request.url, request.partitionKey);
  }

  async closeTab(engineTabId: string): Promise<void> {
    return this.tabs.closeTab(engineTabId);
  }

  /**
   * Attestation: probe a fresh about:blank target over CDP and report what
   * the engine actually materialized. Uses the discovered browser-level
   * endpoint (same resolver as tab routing); failures become
   * ATTESTATION_UNSUPPORTED, never a fabricated "match".
   */
  async captureFingerprint(): Promise<ObservedFingerprint> {
    return captureFingerprintViaDebugPort(
      "camoufox",
      this.debugPort,
      this.wsEndpoint,
    );
  }

  async stop(): Promise<void> {
    if (this.child.exitCode !== null || this.child.killed) return;
    // Release browser contexts (the session partitions) before killing.
    await this.tabs.dispose();
    this.child.kill("SIGTERM");
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("engine stop timeout")), 10_000),
    );
    try {
      await Promise.race([this.exited, timeout]);
    } catch {
      this.child.kill("SIGKILL");
      await this.exited;
    }
  }
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

/** Default binary lookup: env override, then <dataDir>/engines/camoufox/. */
export function defaultCamoufoxPath(dataDir: string): string {
  if (process.env.SPECTRA_CAMOUFOX_PATH)
    return process.env.SPECTRA_CAMOUFOX_PATH;
  const name = process.platform === "win32" ? "camoufox.exe" : "camoufox";
  return path.join(dataDir, "engines", "camoufox", name);
}
