import { execFileSync } from "node:child_process";
import os from "node:os";

/**
 * The host machine's primary display size, for identity generation's
 * host-coherence clamp (see fingerprint-generator). Queried once per process
 * via PowerShell (Node has no display API); non-Windows hosts get null, which
 * means "no clamp" — the caller decides whether that is acceptable.
 */
let cached: { width: number; height: number } | null | undefined;

export function hostPrimaryDisplay(): { width: number; height: number } | null {
  if (cached !== undefined) return cached;
  if (process.platform !== "win32") {
    cached = null;
    return cached;
  }
  try {
    const out = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Add-Type -AssemblyName System.Windows.Forms; " +
          "$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; " +
          "Write-Output (\"$($b.Width)x$($b.Height)\")",
      ],
      { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    const m = /^(\d+)x(\d+)$/.exec(out);
    cached = m ? { width: Number(m[1]), height: Number(m[2]) } : null;
  } catch {
    cached = null;
  }
  return cached;
}

/**
 * The host machine's real physical RAM in GB (floor), for identity
 * generation's memory-coherence clamp: V8's heap limit reveals real RAM to
 * page JS, so a persona claiming more memory than the host ships is a
 * detectable incoherence. Node-only (os.totalmem), all platforms.
 */
let cachedMem: number | undefined;

export function hostMemoryGb(): number {
  if (cachedMem === undefined) cachedMem = Math.floor(os.totalmem() / 2 ** 30);
  return cachedMem;
}
