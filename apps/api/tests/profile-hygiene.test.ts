import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanProfileDirStaleness } from "../src/application/runtime/profile-hygiene.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "qp-hygiene-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("cleanProfileDirStaleness", () => {
  it("removes singleton residue and stale debug-port files only", () => {
    for (const name of [
      "DevToolsActivePort",
      "SingletonLock",
      "SingletonSocket",
      "SingletonCookie",
      ".org.chromium.Chromium.abc123",
    ]) {
      fs.writeFileSync(path.join(dir, name), "stale");
    }
    // Profile DATA must survive untouched.
    fs.mkdirSync(path.join(dir, "Default"));
    fs.writeFileSync(path.join(dir, "Default", "Bookmarks"), "{}");
    fs.writeFileSync(path.join(dir, "fury-config.json"), "{}");
    fs.writeFileSync(path.join(dir, "Local State"), "{}");

    const report = cleanProfileDirStaleness(dir);
    expect(report.removed.sort()).toEqual([
      ".org.chromium.Chromium.abc123",
      "DevToolsActivePort",
      "SingletonCookie",
      "SingletonLock",
      "SingletonSocket",
    ]);
    expect(fs.existsSync(path.join(dir, "Default", "Bookmarks"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "fury-config.json"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "Local State"))).toBe(true);
  });

  it("is a quiet no-op on a fresh/empty profile dir", () => {
    expect(cleanProfileDirStaleness(dir)).toEqual({
      removed: [],
      sessionMarkedClean: false,
    });
    expect(cleanProfileDirStaleness(path.join(dir, "does-not-exist"))).toEqual({
      removed: [],
      sessionMarkedClean: false,
    });
  });

  it("rewrites a Crashed exit marker to Normal so relaunch never restores old tabs", () => {
    fs.mkdirSync(path.join(dir, "Default"));
    const prefsPath = path.join(dir, "Default", "Preferences");
    fs.writeFileSync(
      prefsPath,
      JSON.stringify({ profile: { exit_type: "Crashed", name: "Default" } }),
    );

    const report = cleanProfileDirStaleness(dir);
    expect(report.sessionMarkedClean).toBe(true);

    const after = JSON.parse(fs.readFileSync(prefsPath, "utf8")) as {
      profile: { exit_type: string; name: string };
    };
    expect(after.profile.exit_type).toBe("Normal");
    expect(after.profile.name).toBe("Default"); // untouched fields survive
  });

  it("leaves a clean exit marker alone", () => {
    fs.mkdirSync(path.join(dir, "Default"));
    fs.writeFileSync(
      path.join(dir, "Default", "Preferences"),
      JSON.stringify({ profile: { exit_type: "Normal" } }),
    );
    expect(cleanProfileDirStaleness(dir).sessionMarkedClean).toBe(false);
  });
});
