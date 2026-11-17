import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../../infrastructure/atomic-write.js";

/**
 * Per-profile os-crypt key (Fury parity 0110) — the key that encrypts the
 * profile's cookies/passwords at rest.
 *
 * Stored INSIDE the profile directory (`<profileDataDir>/.queuepilot/
 * oscrypt.key`, 0o600) rather than in the DPAPI SecretStore, deliberately:
 * Fury's 0110 design intent is a key that TRAVELS WITH THE PROFILE, so a
 * profile moved to another machine (or restored from a session bundle) still
 * opens its cookie jar. DPAPI would machine-bind it and every moved profile
 * would degrade to an empty jar. Transport protection is the bundle's own
 * passphrase encryption (session bundles v2) — the key file is only at rest
 * on a machine the operator already trusts with the whole profile.
 *
 * Trade-off documented honestly in docs/parity.md: anyone with file access
 * to the profile dir can decrypt its cookies. That is exactly the same trust
 * boundary as the unencrypted-elsewhere profile data and weaker than nothing
 * we claim otherwise.
 *
 * Contract (from engine/patches/0110-os-crypt-key.patch): exactly 32 bytes,
 * handed to the engine as an inherited HANDLE via
 * `--fury-oscrypt-file-handle=<uint32>` on Windows (`--fury-oscrypt-fd` on
 * POSIX). A missing/wrong key is NOT fatal — the engine falls back to the
 * machine key, or discards an unreadable jar (login again), never refuses
 * to start.
 */

const KEY_FILE = path.join(".queuepilot", "oscrypt.key");
const KEY_SIZE = 32;

export function oscryptKeyPath(profileDataDir: string): string {
  return path.join(profileDataDir, KEY_FILE);
}

/** Returns the key file path, creating a random 32-byte key on first use. */
export function getOrCreateOscryptKey(profileDataDir: string): string {
  const keyPath = oscryptKeyPath(profileDataDir);
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  try {
    const existing = fs.readFileSync(keyPath);
    if (existing.length === KEY_SIZE) return keyPath;
    // Wrong size: rename aside (same discipline as truncated-key handling in
    // the patch — never overwrite something we don't understand) and mint new.
    fs.renameSync(
      keyPath,
      `${keyPath}.bad-${Date.now()}`,
    );
  } catch {
    /* absent — create below */
  }
  writeFileAtomic(keyPath, crypto.randomBytes(KEY_SIZE), { mode: 0o600 });
  return keyPath;
}
