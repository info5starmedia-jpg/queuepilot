import fs from "node:fs";
import {
  DomainError,
  EngineManifestSchema,
  ErrorCodes,
  type EngineManifestEntry,
} from "@queuepilot/contracts";
import { EngineInstaller } from "./engine-installer.js";

/**
 * One-click engine updates (C1). The same checksummed, atomic, rollback-safe
 * EngineInstaller the `queuepilot engine update` CLI uses, offered over HTTP:
 * check() reads the manifest and reports current/available; start() runs the
 * install in the background (a 283 MB engine does not fit in one request)
 * and status() reports it. Downloads are refused unless the owner turned on
 * Settings → Engine → "Allow engine binary downloads".
 */

export const DEFAULT_MANIFEST_URL =
  "https://raw.githubusercontent.com/info5starmedia-jpg/queuepilot/main/engines.manifest.json";

export function currentPlatformTag(): string {
  return process.platform === "win32" ? "windows-x64" : process.platform === "darwin" ? "macos-arm64" : "linux-x64";
}

/** Segment-wise numeric compare; "-qp.N" prereleases order AFTER the base. */
export function compareVersions(a: string, b: string): number {
  const [ab, aq] = a.split("-qp.");
  const [bb, bq] = b.split("-qp.");
  const pa = ab!.split(".").map(Number);
  const pb = bb!.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return (aq ? Number(aq) : -1) - (bq ? Number(bq) : -1);
}

/** A manifest from an http(s) URL or a local file path. */
export async function readManifestRef(ref: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  if (/^https?:\/\//.test(ref)) {
    const res = await fetchImpl(ref);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  }
  return fs.readFileSync(ref, "utf8");
}

/** Newest manifest entry for this platform (and kind, when given). */
export function newestEntry(raw: string, kind: string | null, platform: string): EngineManifestEntry | null {
  const manifest = EngineManifestSchema.safeParse(JSON.parse(raw));
  if (!manifest.success) {
    throw new Error(`invalid manifest: ${manifest.error.issues.map((i) => i.message).join("; ")}`);
  }
  return (
    manifest.data.engines
      .filter((e) => (kind === null || e.kind === kind) && e.platform === platform)
      .sort((a, b) => compareVersions(a.version, b.version))
      .at(-1) ?? null
  );
}

export interface EngineUpdateJob {
  state: "running" | "installed" | "failed";
  version: string;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

export interface EngineUpdateCheck {
  status: "current" | "available" | "error";
  /** The manifest this check read (settings URL, env override, or the repo default). */
  source: string;
  /** The newest manifest entry for this platform (no url credentials exist in manifests). */
  latest: { kind: string; version: string; sizeBytes: number | null; url: string } | null;
  consent: boolean;
  error: string | null;
  job: EngineUpdateJob | null;
}

export class EngineUpdateService {
  private job: EngineUpdateJob | null = null;
  private readonly installer: EngineInstaller;

  constructor(
    private readonly opts: {
      enginesDir: string;
      /** Resolved per call, so Settings → Engine → Update server URL applies without a restart. */
      manifestRef: string | (() => string);
      /** The owner's Settings → Engine → downloadConsent, read at call time. */
      consent: () => boolean;
      installer?: EngineInstaller;
      fetchImpl?: typeof fetch;
      platform?: string;
    },
  ) {
    this.installer = opts.installer ?? new EngineInstaller(opts.enginesDir);
  }

  /** Result of the version check run when the API started (null until it ran). */
  launchCheck: (EngineUpdateCheck & { checkedAt: string }) | null = null;

  async check(): Promise<EngineUpdateCheck> {
    const consent = this.opts.consent();
    const source = this.source();
    try {
      const entry = await this.latest();
      if (!entry) return { status: "error", source, latest: null, consent, error: "no engine in the manifest for this platform", job: this.job };
      const latest = { kind: entry.kind, version: entry.version, sizeBytes: entry.sizeBytes ?? null, url: entry.url };
      return { status: this.installer.isInstalled(entry) ? "current" : "available", source, latest, consent, error: null, job: this.job };
    } catch (err) {
      return { status: "error", source, latest: null, consent, error: err instanceof Error ? err.message : String(err), job: this.job };
    }
  }

  /**
   * Version check at launch (hosted-deployment track, client side): check
   * once at API start and remember the answer for the dashboard. It never
   * downloads — installing stays an explicit, consent-gated click.
   */
  async checkAtLaunch(log: (line: string) => void = () => {}): Promise<void> {
    const r = await this.check();
    this.launchCheck = { ...r, checkedAt: new Date().toISOString() };
    if (r.status === "available") log(`engine update available: ${r.latest!.kind} ${r.latest!.version} (from ${r.source}) — Settings → Engine to install`);
    else if (r.status === "error") log(`engine update check failed (${r.source}): ${r.error}`);
  }

  private source(): string {
    return typeof this.opts.manifestRef === "function" ? this.opts.manifestRef() : this.opts.manifestRef;
  }

  /** Start the background install of the newest entry. Resolves once it has started. */
  async start(): Promise<{ started: boolean; version: string; status: "started" | "current" }> {
    if (!this.opts.consent()) {
      throw new DomainError(
        ErrorCodes.ENGINE_DOWNLOAD_REQUIRES_CONSENT,
        "engine downloads are off — turn on Settings → Engine → Allow engine binary downloads first",
      );
    }
    if (this.job?.state === "running") {
      throw new DomainError(ErrorCodes.CONFLICT, `engine ${this.job.version} is already being installed`);
    }
    const entry = await this.latest();
    if (!entry) throw new DomainError(ErrorCodes.ENGINE_MANIFEST_INVALID, "no engine in the manifest for this platform");
    if (this.installer.isInstalled(entry)) return { started: false, version: entry.version, status: "current" };

    const job: EngineUpdateJob = { state: "running", version: entry.version, startedAt: new Date().toISOString(), finishedAt: null, error: null };
    this.job = job;
    void this.installer.install(entry, { consent: true }).then(
      () => Object.assign(job, { state: "installed", finishedAt: new Date().toISOString() }),
      (err) => Object.assign(job, { state: "failed", finishedAt: new Date().toISOString(), error: err instanceof Error ? err.message : String(err) }),
    );
    return { started: true, version: entry.version, status: "started" };
  }

  private async latest(): Promise<EngineManifestEntry | null> {
    const raw = await readManifestRef(this.source(), this.opts.fetchImpl);
    return newestEntry(raw, "fury-core", this.opts.platform ?? currentPlatformTag());
  }
}
