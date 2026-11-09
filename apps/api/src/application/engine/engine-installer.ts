import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  DomainError,
  ErrorCodes,
  InstalledEngineSchema,
  type EngineManifestEntry,
  type InstalledEngine,
} from "@queuepilot/contracts";

type Fetcher = (url: string) => Promise<Uint8Array>;

const defaultFetcher: Fetcher = async (url) => {
  if (url.startsWith("file://")) {
    return new Uint8Array(fs.readFileSync(new URL(url)));
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
};

/**
 * EngineInstaller — consent-gated, checksummed, atomic engine installs.
 *
 * Rules (non-negotiable, tested):
 *  1. No consent, no download. Engines are large third-party binaries; the
 *     user must explicitly ask. Refusal is a named error, not a silent skip.
 *  2. The downloaded bytes must hash to the manifest's pinned SHA-256.
 *     Mismatch deletes the payload and refuses — a tampered engine is a
 *     supply-chain attack on every account the user owns.
 *  3. Installs are atomic: payload lands in a temp file, verifies, then the
 *     engine directory is renamed into place. A crash mid-install never
 *     leaves a half-installed engine that looks usable.
 *  4. Idempotent: an engine whose receipt exists and matches the manifest
 *     checksum is not re-downloaded.
 */
export class EngineInstaller {
  constructor(
    private readonly enginesDir: string,
    private readonly fetcher: Fetcher = defaultFetcher,
  ) {
    fs.mkdirSync(this.enginesDir, { recursive: true });
  }

  async install(
    entry: EngineManifestEntry,
    opts: { consent: boolean },
  ): Promise<InstalledEngine> {
    if (!opts.consent) {
      throw new DomainError(
        ErrorCodes.ENGINE_DOWNLOAD_REQUIRES_CONSENT,
        `engine ${entry.kind}@${entry.version} requires explicit consent before downloading ${entry.url}`,
      );
    }

    const dir = this.engineDir(entry);
    const receiptFile = path.join(dir, "install.json");
    const existing = this.readReceipt(receiptFile);
    if (existing && existing.sha256 === entry.sha256) {
      return existing; // idempotent: already installed and verified
    }

    const payload = await this.fetcher(entry.url);
    const digest = createHash("sha256").update(payload).digest("hex");
    if (digest !== entry.sha256) {
      throw new DomainError(
        ErrorCodes.ENGINE_CHECKSUM_MISMATCH,
        `engine ${entry.kind}@${entry.version} checksum mismatch: manifest pins ${entry.sha256}, download hashed ${digest} — payload discarded`,
      );
    }

    // Stage in a sibling temp dir, then atomic rename into place.
    const staging = `${dir}.staging-${process.pid}-${Date.now()}`;
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });
    fs.writeFileSync(path.join(staging, "payload.bin"), payload);

    const receipt: InstalledEngine = InstalledEngineSchema.parse({
      kind: entry.kind,
      version: entry.version,
      platform: entry.platform,
      sha256: entry.sha256,
      url: entry.url,
      installedAt: new Date().toISOString(),
      dir,
    });
    fs.writeFileSync(path.join(staging, "install.json"), JSON.stringify(receipt, null, 2));

    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(staging, dir);
    return receipt;
  }

  isInstalled(entry: EngineManifestEntry): boolean {
    const receipt = this.readReceipt(path.join(this.engineDir(entry), "install.json"));
    return receipt !== null && receipt.sha256 === entry.sha256;
  }

  private engineDir(entry: EngineManifestEntry): string {
    return path.join(this.enginesDir, entry.kind, entry.version, entry.platform);
  }

  private readReceipt(file: string): InstalledEngine | null {
    if (!fs.existsSync(file)) return null;
    try {
      return InstalledEngineSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
    } catch {
      return null; // corrupt receipt = treat as not installed
    }
  }
}
