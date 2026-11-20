import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DomainError, ErrorCodes } from "@queuepilot/contracts";
import { APP_VERSION } from "../../version.js";
import { compareVersions } from "../engine/engine-update.service.js";

/**
 * Family-release app updates (the missing half of "hand it to family"):
 * engine updates already self-serve from the manifest; the APP itself
 * updated only via git. This service mirrors EngineUpdateService's shape:
 *
 *   GET /app/update   — free check against latest.json on the GitHub release
 *   POST /app/update  — consent-gated; downloads the checksummed release zip,
 *                       spawns the detached swap-and-restart helper, exits.
 *
 * Flavors:
 *   release — an extracted release zip (install.json marker next to the
 *     bundled server). Updating swaps server/+dashboard/+package.json and
 *     restarts; profiles/proxies/settings live in the data dir and survive.
 *   dev — this source checkout. status "unavailable": git pull is the
 *     updater; the dashboard says so instead of offering a dead button.
 */

export const DEFAULT_LATEST_URL =
  "https://github.com/info5starmedia-jpg/queuepilot/releases/latest/download/latest.json";

const LatestSchema = {
  parse(raw: unknown): { version: string; url: string; sha256: string; sizeBytes: number | null } {
    const o = raw as Record<string, unknown>;
    if (typeof o?.version !== "string" || !o.version) throw new Error("latest.json: missing version");
    if (typeof o?.url !== "string" || !/^https:\/\//.test(o.url)) throw new Error("latest.json: missing https url");
    if (typeof o?.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(o.sha256)) throw new Error("latest.json: missing sha256");
    return { version: o.version, url: o.url, sha256: o.sha256, sizeBytes: typeof o.sizeBytes === "number" ? o.sizeBytes : null };
  },
};

export interface AppUpdateJob {
  state: "running" | "restarting" | "installed" | "failed";
  version: string;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

export interface AppUpdateCheck {
  flavor: "release" | "dev";
  version: string;
  status: "current" | "available" | "unavailable" | "error";
  latest: { version: string; sizeBytes: number | null; url: string } | null;
  consent: boolean;
  error: string | null;
  job: AppUpdateJob | null;
}

/** Locate the extracted-release root by its install.json marker. The bundled
 *  server sits at <root>/server/queuepilot.mjs; dev (tsx) has no marker at all. */
export function resolveAppRoot(bundleUrl: string | null = null): string | null {
  const seeds: string[] = [];
  if (bundleUrl?.startsWith("file:")) {
    try {
      seeds.push(path.dirname(fileURLToPath(bundleUrl)));
    } catch {
      /* keep looking */
    }
  }
  seeds.push(process.cwd(), path.dirname(process.cwd()));
  for (const s of seeds) {
    for (const c of [s, path.dirname(s)]) {
      if (fs.existsSync(path.join(c, "install.json"))) return c;
    }
  }
  return null;
}

export class AppUpdateService {
  private job: AppUpdateJob | null = null;

  constructor(
    private readonly opts: {
      consent: () => boolean;
      latestRef?: string | (() => string);
      dataDir: string;
      /** Test seam. Defaults to this module's location. */
      appRoot?: string | null;
      fetchImpl?: typeof fetch;
      platform?: string;
      /** Test seam for the detached swap helper. */
      spawnImpl?: (cmd: string, args: string[]) => unknown;
      /** Test seam for the post-spawn exit. */
      exitImpl?: () => void;
    },
  ) {}

  private get appRoot(): string | null {
    if ("appRoot" in this.opts) return this.opts.appRoot ?? null;
    return resolveAppRoot(import.meta.url);
  }

  private get platform(): string {
    return this.opts.platform ?? process.platform;
  }

  private source(): string {
    const ref = this.opts.latestRef ?? DEFAULT_LATEST_URL;
    return typeof ref === "function" ? ref() : ref;
  }

  private get fetchImpl(): typeof fetch {
    return this.opts.fetchImpl ?? fetch;
  }

  private get isRelease(): boolean {
    return this.appRoot !== null && this.platform === "win32";
  }

  async check(): Promise<AppUpdateCheck> {
    const consent = this.opts.consent();
    const version = APP_VERSION;
    const root = this.appRoot;
    if (!root) {
      return { flavor: "dev", version, status: "unavailable", latest: null, consent, error: "development checkout — update with git pull", job: this.job };
    }
    if (this.platform !== "win32") {
      return { flavor: "release", version, status: "unavailable", latest: null, consent, error: "app self-update is Windows-only for now", job: this.job };
    }
    try {
      const latest = await this.latest();
      return {
        flavor: "release",
        version,
        status: compareVersions(latest.version, version) > 0 ? "available" : "current",
        latest: { version: latest.version, sizeBytes: latest.sizeBytes, url: latest.url },
        consent,
        error: null,
        job: this.job,
      };
    } catch (err) {
      return { flavor: "release", version, status: "error", latest: null, consent, error: err instanceof Error ? err.message : String(err), job: this.job };
    }
  }

  async start(): Promise<{ started: boolean; version: string; status: "started" | "current" }> {
    if (!this.opts.consent()) {
      throw new DomainError(
        ErrorCodes.ENGINE_DOWNLOAD_REQUIRES_CONSENT,
        "app downloads are off — turn on Settings → Engine → Allow engine binary downloads first",
      );
    }
    if (this.job?.state === "running" || this.job?.state === "restarting") {
      throw new DomainError(ErrorCodes.CONFLICT, `app ${this.job.version} is already being installed`);
    }
    const root = this.appRoot;
    if (!root) throw new DomainError(ErrorCodes.VALIDATION_FAILED, "not a release install — update the app with git pull");
    if (this.platform !== "win32") throw new DomainError(ErrorCodes.VALIDATION_FAILED, "app self-update is Windows-only for now");

    const latest = await this.latest();
    if (compareVersions(latest.version, APP_VERSION) <= 0) return { started: false, version: latest.version, status: "current" };

    const job: AppUpdateJob = { state: "running", version: latest.version, startedAt: new Date().toISOString(), finishedAt: null, error: null };
    this.job = job;
    void this.install(root, latest, job).catch((err) =>
      Object.assign(job, { state: "failed", finishedAt: new Date().toISOString(), error: err instanceof Error ? err.message : String(err) }),
    );
    return { started: true, version: latest.version, status: "started" };
  }

  private async latest() {
    const res = await this.fetchImpl(this.source());
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return LatestSchema.parse(await res.json());
  }

  private async install(
    root: string,
    latest: { version: string; url: string; sha256: string },
    job: AppUpdateJob,
  ): Promise<void> {
    // 1. Download + verify into the data dir (outside the app root, so the
    //    swap never touches the file it is replacing).
    const res = await this.fetchImpl(latest.url);
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const sha = crypto.createHash("sha256").update(buf).digest("hex");
    if (sha !== latest.sha256) throw new Error(`sha256 mismatch (got ${sha.slice(0, 12)}…, expected ${latest.sha256.slice(0, 12)}…)`);
    const updatesDir = path.join(this.opts.dataDir, "updates");
    fs.mkdirSync(updatesDir, { recursive: true });
    const zip = path.join(updatesDir, `app-${latest.version}.zip`);
    fs.writeFileSync(zip, buf);

    // 2. Hand the swap to the detached helper and exit. The helper waits for
    //    this process to die (the native sqlite addon locks node_modules while
    //    we live), replaces the app files, then relaunches the dashboard.
    const script = path.join(root, "update-app.ps1");
    if (!fs.existsSync(script)) throw new Error(`updater missing: ${script}`);
    const spawnImpl =
      this.opts.spawnImpl ??
      ((cmd: string, args: string[]) => {
        const child = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true });
        child.unref();
        return child;
      });
    spawnImpl("powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script,
      "-Zip", zip, "-AppRoot", root, "-OldPid", String(process.pid),
    ]);
    Object.assign(job, { state: "restarting" });
    const exitImpl = this.opts.exitImpl ?? (() => setTimeout(() => process.exit(0), 800));
    exitImpl();
  }
}
