import fs from "node:fs";
import {
  DomainError,
  EngineManifestSchema,
  ErrorCodes,
  type EngineManifestEntry,
} from "@queuepilot/contracts";
import { EngineInstaller } from "../application/engine/engine-installer.js";

/**
 * P5.2 — `queuepilot engine update [--manifest <url|file>] [--kind k] [--yes] [--json]`
 *
 * Pulls the engine manifest (default: the repo's raw URL), picks the newest
 * entry for this platform, and installs it through the same checksummed,
 * atomic EngineInstaller as `engine install`. Already-current is a clean
 * no-op. The consent gate is literal: without --yes nothing is downloaded.
 * The previously installed version is left untouched (the resolver prefers
 * the newest verified receipt), so a bad new build never strands the user —
 * deleting the new receipt rolls back.
 */

export const DEFAULT_MANIFEST_URL =
  "https://raw.githubusercontent.com/info5starmedia-jpg/queuepilot/main/engines.manifest.json";

export interface EngineUpdateDeps {
  enginesDir: string;
  installer?: EngineInstaller;
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
}

export async function runEngineUpdate(
  argv: string[],
  deps: EngineUpdateDeps,
): Promise<number> {
  const log = deps.log ?? ((m: string) => console.log(m));
  let manifestRef: string = DEFAULT_MANIFEST_URL;
  let kind: string | null = null;
  let yes = false;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--manifest") manifestRef = argv[++i] ?? manifestRef;
    else if (a === "--kind") kind = argv[++i] ?? null;
    else if (a === "--yes") yes = true;
    else if (a === "--json") json = true;
  }

  let raw: string;
  try {
    raw = await readRef(manifestRef, deps.fetchImpl ?? fetch);
  } catch (err) {
    log(`cannot fetch manifest ${manifestRef}: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }

  const manifest = EngineManifestSchema.safeParse(JSON.parse(raw));
  if (!manifest.success) {
    log(`invalid manifest: ${manifest.error.issues.map((i) => i.message).join("; ")}`);
    return 2;
  }

  const platform = currentPlatformTag();
  const candidates = manifest.data.engines
    .filter((e) => (kind === null || e.kind === kind) && e.platform === platform)
    .sort((a, b) => compareVersions(a.version, b.version));
  const newest = candidates.at(-1);
  if (!newest) {
    log(`no engine in the manifest matches kind=${kind ?? "*"} platform=${platform}`);
    return 2;
  }

  const installer = deps.installer ?? new EngineInstaller(deps.enginesDir);
  if (installer.isInstalled(newest)) {
    log(json ? JSON.stringify({ status: "current", version: newest.version }) : `${newest.kind}@${newest.version} is current — nothing to do.`);
    return 0;
  }

  if (!yes) {
    log(
      [
        `update available: ${newest.kind}@${newest.version} (${platform})`,
        `  url:    ${newest.url}`,
        `  sha256: ${newest.sha256}`,
        `Re-run with --yes to install. Nothing was downloaded.`,
      ].join("\n"),
    );
    return 1;
  }

  try {
    const receipt = await installer.install(newest, { consent: true });
    log(
      json
        ? JSON.stringify({ status: "installed", version: receipt.version, dir: receipt.dir })
        : `installed ${receipt.kind}@${receipt.version} -> ${receipt.dir}\n` +
          `the previous version is untouched; delete the new receipt dir to roll back.`,
    );
    return 0;
  } catch (err) {
    if (err instanceof DomainError && err.code === ErrorCodes.ENGINE_CHECKSUM_MISMATCH) {
      log(`CHECKSUM MISMATCH — payload discarded, previous version still active.\n${err.message}`);
      return 3;
    }
    log(`update failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

async function readRef(ref: string, fetchImpl: typeof fetch): Promise<string> {
  if (/^https?:\/\//.test(ref)) {
    const res = await fetchImpl(ref);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  }
  return fs.readFileSync(ref, "utf8");
}

function currentPlatformTag(): string {
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

// Referenced only for typing of sorted entries.
export type { EngineManifestEntry };
