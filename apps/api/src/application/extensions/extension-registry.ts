import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { SecretStore } from "../secrets/secret-store.js";
import { pinnedExtensionKey } from "./extension-id.js";
import { crxToZip, unzipTo } from "./zip.js";
import { resolveContainedPath } from "../paths/contained-path.js";

/**
 * Per-profile extension registry (P7, Fury 0.5.4 v2 semantics).
 *
 * - Sources: .crx (CRX3), .zip, or an unpacked folder.
 * - Installed under `<profileDataDir>/Default/Extensions/<pinned-id>/<version>/`
 *   — Chromium's own unpacked-install layout, so the engine picks extensions
 *   up on next start with no engine-side changes.
 * - The id is PINNED: derived from an RSA key per extension NAME, kept
 *   machine-side in the SecretStore. Same name → same id across versions and
 *   profiles (storage references survive upgrades).
 * - Copy-from-profile copies ONLY the install dir — never `Local Extension
 *   Settings/<id>`, `Sync Data`, or any other storage (shared storage would
 *   tie two personas together; Fury flags this exact mistake).
 * - A small registry JSON per profile (`.queuepilot/extensions.json`) tracks
 *   what WE installed; the operator can still sideload by hand, we just don't
 *   track it.
 */

export interface InstalledExtension {
  /** Pinned Chrome-style id (from the name key). */
  id: string;
  /** manifest.json name — the pinning key. */
  name: string;
  version: string;
  installedAt: string;
  source: string;
}

const REGISTRY = path.join(".queuepilot", "extensions.json");

export class ExtensionRegistry {
  constructor(
    private readonly dataDir: string,
    private readonly secrets: SecretStore,
  ) {}

  private profileDir(profileId: string): string {
    return path.join(this.dataDir, "profiles", profileId);
  }

  private registryPath(profileId: string): string {
    return path.join(this.profileDir(profileId), REGISTRY);
  }

  private load(profileId: string): InstalledExtension[] {
    try {
      return JSON.parse(fs.readFileSync(this.registryPath(profileId), "utf8"));
    } catch {
      return [];
    }
  }

  private save(profileId: string, entries: InstalledExtension[]): void {
    const file = this.registryPath(profileId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(entries, null, 2));
  }

  private installRoot(profileId: string, extId: string, version: string): string {
    return path.join(
      this.profileDir(profileId),
      "Default",
      "Extensions",
      extId,
      version,
    );
  }

  list(profileId: string): InstalledExtension[] {
    return this.load(profileId);
  }

  /**
   * Install from a .crx / .zip / unpacked folder. Returns the registry entry.
   * Atomic-ish: extract into a temp dir, then rename into place.
   */
  install(profileId: string, sourcePath: string): InstalledExtension {
    // v0.15.0 (audit A-rec #2): the install source is an HTTP-supplied path —
    // confine it to `<dataDir>/extension-sources` and refuse symlinks, so a
    // loopback web page cannot hand us an arbitrary local file to copy.
    const safe = resolveContainedPath(sourcePath, [
      path.join(this.dataDir, "extension-sources"),
    ]);
    if (!fs.existsSync(safe)) {
      throw new Error(`extension source not found: ${sourcePath}`);
    }
    const staging = path.join(
      this.profileDir(profileId),
      ".queuepilot",
      `ext-staging-${randomUUID()}`,
    );
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });
    try {
      const stat = fs.statSync(safe);
      if (stat.isDirectory()) {
        copyTree(safe, staging);
      } else {
        const buf = fs.readFileSync(safe);
        const zip =
          safe.toLowerCase().endsWith(".crx") ? crxToZip(buf) : buf;
        unzipTo(zip, staging);
      }
      // Packages frequently nest everything one folder deep ("ext-1.2.3/
      // manifest.json"); lift the contents so the root check below sees the
      // manifest (Fury issue-28 behavior). Ambiguous or deeper nesting is
      // left alone — the root check then fails loudly, never guesses.
      resolveManifestRoot(staging);
      const manifestPath = path.join(staging, "manifest.json");
      if (!fs.existsSync(manifestPath)) {
        throw new Error("extension package has no manifest.json at its root");
      }
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
        name?: string;
        version?: string;
      };
      const name = manifest.name;
      const version = manifest.version;
      if (typeof name !== "string" || name.length === 0) {
        throw new Error("extension manifest has no name");
      }
      if (typeof version !== "string" || version.length === 0) {
        throw new Error("extension manifest has no version");
      }

      const { id } = pinnedExtensionKey(this.secrets, name);
      const target = this.installRoot(profileId, id, version);
      fs.rmSync(target, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.renameSync(staging, target);

      const entry: InstalledExtension = {
        id,
        name,
        version,
        installedAt: new Date().toISOString(),
        source: path.basename(sourcePath),
      };
      const entries = this.load(profileId).filter((e) => e.id !== id);
      entries.push(entry);
      this.save(profileId, entries);
      return entry;
    } catch (err) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  /**
   * Copy an extension from another profile WITHOUT its storage — only the
   * install dir (code + _metadata) moves. Local Extension Settings, Sync
   * Data, and every other per-profile datum stays behind on purpose.
   */
  copyFrom(
    profileId: string,
    fromProfileId: string,
    extensionId: string,
  ): InstalledExtension {
    const source = this.load(fromProfileId).find((e) => e.id === extensionId);
    if (!source) {
      throw new Error(`extension ${extensionId} not installed on profile ${fromProfileId}`);
    }
    const srcDir = this.installRoot(fromProfileId, source.id, source.version);
    if (!fs.existsSync(srcDir)) {
      throw new Error(`extension install dir missing: ${srcDir}`);
    }
    const target = this.installRoot(profileId, source.id, source.version);
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // Storage-free by construction: only the Extensions/<id>/<version> tree
    // is copied; per-profile storage lives elsewhere in Default/.
    copyTree(srcDir, target);
    const entry: InstalledExtension = {
      ...source,
      installedAt: new Date().toISOString(),
      source: `copy:${fromProfileId}`,
    };
    const entries = this.load(profileId).filter((e) => e.id !== entry.id);
    entries.push(entry);
    this.save(profileId, entries);
    return entry;
  }

  /** Remove the install dir, its storage, and the registry entry. */
  remove(profileId: string, extensionId: string): boolean {
    const entries = this.load(profileId);
    const entry = entries.find((e) => e.id === extensionId);
    if (!entry) return false;
    const extRoot = path.join(this.profileDir(profileId), "Default", "Extensions", extensionId);
    fs.rmSync(extRoot, { recursive: true, force: true });
    // The profile's own storage for this extension goes too — removal is
    // removal, unlike copy-from which deliberately never touches storage.
    const storage = path.join(
      this.profileDir(profileId),
      "Default",
      "Local Extension Settings",
      extensionId,
    );
    fs.rmSync(storage, { recursive: true, force: true });
    this.save(
      profileId,
      entries.filter((e) => e.id !== extensionId),
    );
    return true;
  }
}

/** Recursive copy (fs.cpSync is available on Node 18+, used with explicit filter). */
function copyTree(src: string, dst: string): void {
  fs.cpSync(src, dst, {
    recursive: true,
    // Finder folder-copies carry __MACOSX too; same rule as unzipTo.
    filter: (s) => !s.split(/[\\/]/).includes("__MACOSX"),
  });
}

/**
 * If the package nests everything under a single root folder, lift its
 * contents into `staging` so manifest.json lands at the top. Only lifts when
 * EXACTLY ONE non-junk subdirectory exists and it holds the manifest —
 * anything else is left for the caller's root check to reject loudly.
 */
function resolveManifestRoot(staging: string): void {
  if (fs.existsSync(path.join(staging, "manifest.json"))) return;
  const subs = fs
    .readdirSync(staging, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== "__MACOSX")
    .map((e) => e.name);
  if (subs.length !== 1) return;
  const inner = path.join(staging, subs[0]!);
  if (!fs.existsSync(path.join(inner, "manifest.json"))) return;
  for (const entry of fs.readdirSync(inner)) {
    fs.renameSync(path.join(inner, entry), path.join(staging, entry));
  }
  fs.rmdirSync(inner);
}
