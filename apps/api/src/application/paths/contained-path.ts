import fs from "node:fs";
import path from "node:path";
import { DomainError, ErrorCodes } from "@queuepilot/contracts";

/**
 * Caller-supplied path containment (audit A-rec #2, v0.15.0).
 *
 * Provider refreshes and extension installs take a `sourcePath` over HTTP.
 * On a loopback-only API that means any web page the operator visits can
 * point the route at an arbitrary local file. This helper is the fix:
 *
 *  - the path is resolved to an absolute form,
 *  - every EXISTING path component is lstat'd — a symlink anywhere along
 *    the chain is refused outright (no symlink hops out of the root),
 *  - containment is verified against the realpath'd allowed roots, so a
 *    symlinked root directory cannot smuggle a path past the check either.
 *
 * A path whose tail does not exist yet still resolves; the caller's own
 * read then fails with its usual "source unreadable" error.
 */
export function resolveContainedPath(rawPath: string, roots: string[]): string {
  if (typeof rawPath !== "string" || rawPath.trim() === "") {
    throw new DomainError(
      ErrorCodes.VALIDATION_FAILED,
      "source path must be a non-empty string",
    );
  }
  const resolved = path.resolve(rawPath);

  // Reject symlinked components anywhere along the existing chain.
  const root = path.parse(resolved).root;
  let probe = root;
  for (const seg of resolved.slice(root.length).split(path.sep)) {
    if (!seg) continue;
    probe = path.join(probe, seg);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(probe);
    } catch {
      break; // tail missing — the caller's read reports it properly
    }
    if (stat.isSymbolicLink()) {
      throw new DomainError(
        ErrorCodes.VALIDATION_FAILED,
        `refusing symlinked path component: ${probe}`,
      );
    }
  }

  // Containment against realpath'd roots (falls back to the lexical path
  // when the root itself does not exist yet).
  const realTarget = safeRealpath(resolved);
  for (const allowed of roots) {
    const realRoot = safeRealpath(path.resolve(allowed));
    const rel = path.relative(realRoot, realTarget);
    if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
      return resolved;
    }
  }
  throw new DomainError(
    ErrorCodes.VALIDATION_FAILED,
    `path is outside the allowed directories (${roots.join(", ")}): ${rawPath}`,
  );
}

function safeRealpath(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}
