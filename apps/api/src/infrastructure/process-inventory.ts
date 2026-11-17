import { execFileSync, spawn } from "node:child_process";
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

/**
 * What we can PROVE about the process behind a PID:
 *  - "match":    alive, and its start time equals the stored token — ours.
 *  - "mismatch": alive, but started at a different time — a stranger that
 *                inherited the PID. Our engine is dead.
 *  - "unknown":  alive, but identity is unprovable (no stored token, or the
 *                OS refused the start-time read). Never grounds for a kill.
 *  - "dead":     no such process.
 */
export type ProcessIdentity = "match" | "mismatch" | "unknown" | "dead";

export function checkProcessIdentity(
  pid: number | null | undefined,
  expectedToken?: string | null,
): ProcessIdentity {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return "dead";
  try {
    process.kill(pid, 0);
  } catch (err) {
    // EPERM means the process exists but is owned by another user.
    if ((err as NodeJS.ErrnoException).code !== "EPERM") return "dead";
  }
  if (!expectedToken) return "unknown";
  const actual = captureProcessStartToken(pid);
  if (actual === null) return "unknown";
  return actual === expectedToken ? "match" : "mismatch";
}

/**
 * Liveness with the soft-failure bias: "unknown" counts as alive, because we
 * cannot disprove identity and a guessed death would kill healthy sessions.
 * Callers that must distinguish proven from assumed use checkProcessIdentity.
 */
export function isProcessAlive(pid: number, expectedToken?: string | null): boolean {
  const identity = checkProcessIdentity(pid, expectedToken);
  return identity === "match" || identity === "unknown";
}

/** Clock/whole-second slack when comparing a start token to a run's start. */
const START_TOKEN_TOLERANCE_MS = 2_000;

/**
 * The start token to store for a run launched at `runStartedAt`, or null.
 * The run row is written BEFORE the engine spawns, so our engine cannot have
 * started earlier than that. A token that predates it belongs to a stranger
 * that inherited the PID between spawn and capture — storing it would make
 * reconciliation "prove" the wrong process, so it is dropped (null = plain
 * liveness, the honest fallback).
 */
export function startTokenForRun(pid: number, runStartedAt: string): string | null {
  const token = captureProcessStartToken(pid);
  if (token === null) return null;
  const started = Date.parse(token);
  const floor = Date.parse(runStartedAt) - START_TOKEN_TOLERANCE_MS;
  if (!Number.isFinite(started) || started < floor) return null;
  return token;
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

/**
 * Ask a process to exit. Windows: taskkill /T (without /F it posts WM_CLOSE,
 * which Chromium treats as a clean shutdown; /F terminates). POSIX: SIGTERM,
 * or SIGKILL when forced. Resolves when the request was made, not when the
 * process is gone — pair with waitForProcessExit.
 *
 * NEVER call this on a PID whose identity is not a proven "match": after an
 * API restart a PID is just a number, and it may belong to a stranger.
 */
export function terminateProcess(pid: number, force: boolean): Promise<void> {
  if (process.platform !== "win32") {
    try {
      process.kill(pid, force ? "SIGKILL" : "SIGTERM");
    } catch {
      /* already gone */
    }
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const args = ["/PID", String(pid), "/T"];
    if (force) args.push("/F");
    const p = spawn("taskkill", args, { stdio: "ignore", windowsHide: true });
    p.once("exit", () => resolve());
    p.once("error", () => resolve());
  });
}

/** Poll until `pid` is gone. True = exited within the window. */
export async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (checkProcessIdentity(pid) === "dead") return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
}
