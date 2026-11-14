import fs from "node:fs";
import path from "node:path";

/**
 * Profile-dir hygiene (P5.6): Chromium leaves singleton files behind when it
 * dies ungracefully (taskkill /F, power loss, API crash mid-run). The next
 * launch of the same profile then hits stale singleton state — Chromium may
 * refuse to start, open a second-browser dialog, or read a dead
 * DevToolsActivePort. AliasMode's answer, adopted here: the launcher owns
 * cleanup, and it runs ONLY after the lifecycle layer has proven no live
 * process occupies this profile (per-profile mutex + occupying run row), so
 * we can never delete a lock a live engine is holding.
 *
 * What we remove (all are recreation-safe: Chromium regenerates them):
 *  - DevToolsActivePort            (stale debug-port pointer)
 *  - SingletonLock                 (symlink on POSIX; plain file on Windows)
 *  - SingletonSocket / SingletonCookie
 *  - .org.chromium.Chromium.*      (SHA1-profile singleton residue)
 * Everything else in the profile dir is left byte-for-byte alone.
 */

const STALE_NAMES = new Set([
  "DevToolsActivePort",
  "SingletonLock",
  "SingletonSocket",
  "SingletonCookie",
]);

export interface HygieneReport {
  removed: string[];
}

/**
 * Remove known stale singleton state from a profile dir. Missing files are
 * not an error; nothing here is load-bearing for profile data (bookmarks,
 * cookies, personas live elsewhere in the tree).
 */
export function cleanProfileDirStaleness(profileDataDir: string): HygieneReport {
  const removed: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(profileDataDir, { withFileTypes: true });
  } catch {
    return { removed }; // dir absent (first launch) — nothing to clean
  }
  for (const entry of entries) {
    const stale =
      STALE_NAMES.has(entry.name) || entry.name.startsWith(".org.chromium.");
    if (!stale) continue;
    const full = path.join(profileDataDir, entry.name);
    try {
      // SingletonLock is a symlink on POSIX — remove the link, never follows.
      fs.rmSync(full, { force: true });
      removed.push(entry.name);
    } catch {
      // A file we cannot remove (in use) is left for the engine to report;
      // deleting harder is how profiles get corrupted.
    }
  }
  return { removed };
}
