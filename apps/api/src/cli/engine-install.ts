import fs from "node:fs";
import {
  DomainError,
  EngineManifestSchema,
  ErrorCodes,
  type EngineManifestEntry,
} from "@queuepilot/contracts";
import { EngineInstaller } from "../application/engine/engine-installer.js";

export interface EngineInstallCliDeps {
  /** Directory engines install into (<dataDir>/engines). */
  enginesDir: string;
  installer?: EngineInstaller;
  log?: (message: string) => void;
}

/**
 * `queuepilot engine install --manifest <file> [--kind k] [--platform p] [--yes]`
 *
 * The consent gate is literal: without --yes nothing is downloaded and the
 * command exits non-zero with the manifest entry printed, so the user can
 * review exactly what they are about to trust. The install itself goes
 * through the same checksummed, atomic EngineInstaller the API uses.
 *
 * Returns the process exit code; throws only on programmer error.
 */
export async function runEngineInstall(
  argv: string[],
  deps: EngineInstallCliDeps,
): Promise<number> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const flags = parseFlags(argv);

  if (!flags.manifest) {
    log(
      "usage: queuepilot engine install --manifest <manifest.json> [--kind <kind>] [--platform <platform>] [--yes]",
    );
    return 2;
  }

  let manifestRaw: unknown;
  try {
    manifestRaw = JSON.parse(fs.readFileSync(flags.manifest, "utf8"));
  } catch (err) {
    log(
      `cannot read manifest: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 2;
  }
  const manifest = EngineManifestSchema.safeParse(manifestRaw);
  if (!manifest.success) {
    log(
      `invalid manifest: ${manifest.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
    return 2;
  }

  const platform = flags.platform ?? currentPlatformTag();
  const entry = pickEntry(manifest.data.engines, flags.kind ?? null, platform);
  if (!entry) {
    log(
      `no engine in the manifest matches kind=${flags.kind ?? "*"} platform=${platform} ` +
        `(available: ${manifest.data.engines.map((e) => `${e.kind}@${e.version}/${e.platform}`).join(", ") || "none"})`,
    );
    return 2;
  }

  const installer = deps.installer ?? new EngineInstaller(deps.enginesDir);

  if (installer.isInstalled(entry)) {
    log(
      `${entry.kind}@${entry.version} (${entry.platform}) already installed and verified — nothing to do.`,
    );
    return 0;
  }

  if (!flags.yes) {
    log(
      [
        `Refusing to download without consent (no bytes moved).`,
        `  engine:   ${entry.kind}@${entry.version}`,
        `  platform: ${entry.platform}`,
        `  url:      ${entry.url}`,
        `  sha256:   ${entry.sha256}`,
        `Re-run with --yes to install.`,
      ].join("\n"),
    );
    return 1;
  }

  try {
    const receipt = await installer.install(entry, { consent: true });
    log(
      `installed ${receipt.kind}@${receipt.version} (${receipt.platform}) -> ${receipt.dir}`,
    );
    return 0;
  } catch (err) {
    if (
      err instanceof DomainError &&
      err.code === ErrorCodes.ENGINE_CHECKSUM_MISMATCH
    ) {
      log(
        `CHECKSUM MISMATCH — payload discarded, nothing installed.\n${err.message}`,
      );
      return 3;
    }
    log(`install failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

function pickEntry(
  entries: EngineManifestEntry[],
  kind: string | null,
  platform: string,
): EngineManifestEntry | null {
  const candidates = entries.filter(
    (e) => (kind === null || e.kind === kind) && e.platform === platform,
  );
  // Newest version last in a manifest is a convention we can't rely on; take
  // the first match and let --kind/--platform disambiguate.
  return candidates[0] ?? null;
}

/** Manifest platform tags: "windows-x64", "linux-arm64", "macos-x64", ... */
export function currentPlatformTag(): string {
  const os =
    process.platform === "win32"
      ? "windows"
      : process.platform === "darwin"
        ? "macos"
        : "linux";
  return `${os}-${process.arch}`;
}

function parseFlags(argv: string[]): {
  manifest: string | null;
  kind: string | null;
  platform: string | null;
  yes: boolean;
} {
  const flags = {
    manifest: null as string | null,
    kind: null as string | null,
    platform: null as string | null,
    yes: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--yes" || arg === "-y") flags.yes = true;
    else if (arg === "--manifest") flags.manifest = argv[++i] ?? null;
    else if (arg === "--kind") flags.kind = argv[++i] ?? null;
    else if (arg === "--platform") flags.platform = argv[++i] ?? null;
  }
  return flags;
}
