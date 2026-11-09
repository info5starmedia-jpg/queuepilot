/**
 * OS-process inventory, used by crash recovery to answer one question:
 * "is the PID this run row points at actually a live browser?"
 *
 * process.kill(pid, 0) is the portable liveness probe (works on Windows and
 * POSIX). Reused-PID protection: we record the PID together with startedAt;
 * a future milestone stores the process start-time/token per platform
 * (see docs/roadmap.md, D-002).
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM means the process exists but is owned by another user.
    return code === "EPERM";
  }
}
