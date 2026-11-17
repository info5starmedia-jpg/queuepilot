import fs from "node:fs";
import path from "node:path";

/**
 * Atomic, durable file write (audit GPT-5.4 finding 5e): the previous
 * write-tmp-then-rename pattern survived a process crash but NOT a power
 * loss — the tmp file's data never reached disk before the rename, and the
 * directory entry was never fsynced either, so the renamed file could come
 * back empty or missing after an unclean shutdown.
 *
 * Order here matters: write → fsync(file) → rename → fsync(parent dir).
 * The dir fsync pins the new directory entry; without it the rename itself
 * can be lost.
 */
export function writeFileAtomic(
  file: string,
  data: string | Buffer,
  opts: { mode?: number } = {},
): void {
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const dir = path.dirname(file);
  try {
    const fd = fs.openSync(tmp, "w", opts.mode ?? 0o644);
    try {
      fs.writeFileSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
    // fsync the directory so the rename is durable (best effort — some
    // platforms restrict dir fd writes; the rename itself is already done).
    try {
      const dfd = fs.openSync(dir, "r");
      try {
        fs.fsyncSync(dfd);
      } finally {
        fs.closeSync(dfd);
      }
    } catch {
      /* dir fsync unsupported — file data itself is durable */
    }
  } catch (err) {
    try {
      fs.rmSync(tmp);
    } catch {
      /* leave nothing behind on failure */
    }
    throw err;
  }
}
