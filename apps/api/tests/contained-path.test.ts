import { describe, expect, it, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveContainedPath } from "../src/application/paths/contained-path.js";
import { ErrorCodes } from "@queuepilot/contracts";

/**
 * resolveContainedPath (audit A-rec #2, v0.15.0): caller-supplied paths are
 * resolved, symlink-checked component by component, and verified against the
 * realpath'd allowed roots.
 */

let root: string;
let outside: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "qp-contain-root-"));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), "qp-contain-out-"));
});

function expectValidationFailed(fn: () => unknown) {
  try {
    fn();
  } catch (err) {
    expect(err).toMatchObject({ code: ErrorCodes.VALIDATION_FAILED });
    return;
  }
  throw new Error("expected resolveContainedPath to throw");
}

describe("resolveContainedPath", () => {
  it("accepts a file inside a root and returns the resolved path", () => {
    const file = path.join(root, "sub", "a.csv");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "x");
    expect(resolveContainedPath(file, [root])).toBe(path.resolve(file));
  });

  it("accepts a not-yet-existing tail inside a root (caller reports the read)", () => {
    const file = path.join(root, "missing.csv");
    expect(resolveContainedPath(file, [root])).toBe(path.resolve(file));
  });

  it("rejects a file outside every root", () => {
    const file = path.join(outside, "b.csv");
    fs.writeFileSync(file, "x");
    expectValidationFailed(() => resolveContainedPath(file, [root]));
  });

  it("rejects traversal that escapes the root", () => {
    const nested = path.join(root, "deep");
    fs.mkdirSync(nested, { recursive: true });
    const escape = path.join(nested, "..", "..", "escape.csv");
    expectValidationFailed(() => resolveContainedPath(escape, [root]));
  });

  it("rejects a relative path that resolves outside the root", () => {
    expectValidationFailed(() =>
      resolveContainedPath(path.relative(process.cwd(), path.join(outside, "c.csv")), [root]),
    );
  });

  it("accepts one of several roots", () => {
    const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), "qp-contain-root2-"));
    const file = path.join(otherRoot, "d.csv");
    fs.writeFileSync(file, "x");
    expect(resolveContainedPath(file, [root, otherRoot])).toBe(path.resolve(file));
  });

  it("rejects an empty path", () => {
    expectValidationFailed(() => resolveContainedPath("   ", [root]));
  });

  it("rejects a symlink whose target is INSIDE the root (no symlinks at all)", () => {
    if (process.platform === "win32") return; // symlink privilege varies on Windows
    const real = path.join(root, "real.csv");
    fs.writeFileSync(real, "x");
    const link = path.join(root, "link.csv");
    fs.symlinkSync(real, link);
    expectValidationFailed(() => resolveContainedPath(link, [root]));
  });

  it("rejects a symlink whose target is OUTSIDE the root", () => {
    if (process.platform === "win32") return; // symlink privilege varies on Windows
    const external = path.join(outside, "secret.csv");
    fs.writeFileSync(external, "x");
    const link = path.join(root, "link-out.csv");
    fs.symlinkSync(external, link);
    expectValidationFailed(() => resolveContainedPath(link, [root]));
  });

  it("rejects a path under a symlinked directory (parent component symlink)", () => {
    if (process.platform === "win32") return; // symlink privilege varies on Windows
    const externalDir = path.join(outside, "dir");
    fs.mkdirSync(externalDir, { recursive: true });
    const linkDir = path.join(root, "linked-dir");
    fs.symlinkSync(externalDir, linkDir);
    expectValidationFailed(() =>
      resolveContainedPath(path.join(linkDir, "e.csv"), [root]),
    );
  });
});
