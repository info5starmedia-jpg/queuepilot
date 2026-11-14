import { execFileSync } from "node:child_process";
import fs from "node:fs";

/**
 * OS-process inventory, used by crash recovery to answer one question:
 * "is the PID this run row points at actually OUR browser?"
 *
 * process.kill(pid, 0) is the portable liveness probe (works on Windows and
 * POSIX) — but liveness alone cannot distinguish our engine from a stranger
 * who inherited the PID after reuse. D-002 closes that: at launch we capture
 * the process start time (Windows: the creation timestamp; POSIX: the kernel
 * start-time from /proc), and reconciliation only adopts a live PID when the
 * start token still matches. Same PID + different start time = reused PID =
 * our engine is dead.
 *
 * Token capture is best-effort and sync (this module runs on the launch and
 * boot-reconcile paths only). When the OS refuses to tell us the start time
 * we store null and fall back to plain liveness — never the other way round
 * (a guessed refusal would "kill" healthy sessions).
 */

export function isProcessAlive(pid: number, expectedToken?: string | null): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM means the process exists but is owned by another user.
    return code === "EPERM";
  }
  if (!expectedToken) return true;
  const actual = captureProcessStartToken(pid);
  // Soft failure to read: we cannot disprove identity — keep it alive.
  if (actual === null) return true;
  return actual === expectedToken;
}

/**
 * The OS start time of `pid` as a normalized UTC string, or null when the
 * platform/permissions refuse. Windows: process creation time via
 * Get-Process (UTC, round-tripped through PowerShell). POSIX: /proc/<pid>
 * field 22 (clock ticks since boot) resolved against btime — monotonic and
 * copy-stable, unlike `ps` output formatting.
 */
export function captureProcessStartToken(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === "win32") return captureWindows(pid);
    return capturePosix(pid);
  } catch {
    return null;
  }
}

function captureWindows(pid: number): string | null {
  const out = execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffffffZ')`,
    ],
    { encoding: "utf8", timeout: 10_000, windowsHide: true },
  ).trim();
  // Normalize to whole-second precision — sub-second variance between two
  // reads of the same process has been observed on busy hosts.
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/.exec(out);
  return m ? `${m[1]}Z` : null;
}

function capturePosix(pid: number): string | null {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  // Field 22 (1-indexed) is starttime in clock ticks since boot. Comm may
  // contain spaces/parens — parse from the LAST ')' onward.
  const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const startTicks = Number(rest[19]); // field 22 minus the first two fields
  const btime = bootTimeTicks();
  if (!Number.isFinite(startTicks) || btime === null) return null;
  const startMs = Math.floor(((btime + startTicks) * 1000) / ticksPerSecond());
  return new Date(startMs).toISOString().slice(0, 19) + "Z";
}

function ticksPerSecond(): number {
  return 100; // Linux USER_HZ
}

let cachedBtime: number | null | undefined;

/** /proc/stat btime (seconds since epoch) — boot time never changes. */
function bootTimeTicks(): number | null {
  if (cachedBtime !== undefined) return cachedBtime;
  try {
    const line = fs
      .readFileSync("/proc/stat", "utf8")
      .split("\n")
      .find((l) => l.startsWith("btime "));
    cachedBtime = line ? Number(line.split(" ")[1]) : null;
  } catch {
    cachedBtime = null;
  }
  return cachedBtime;
}
