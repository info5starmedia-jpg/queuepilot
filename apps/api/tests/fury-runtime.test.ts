import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FingerprintIdentity } from "@queuepilot/contracts";
import {
  personaConfig,
  resolveFuryBinary,
} from "../src/application/runtime/fury-core.runtime.js";

/**
 * Fury core runtime — the persona mapping is the load-bearing piece (it is
 * the contract between our identity model and the engine's C++ config), so
 * it is tested pure. Binary resolution is tested against a synthetic
 * engines/ tree. The live launch path is exercised manually on a real
 * fury-core install (see ADR-0006 spike) — a browser process is out of scope
 * for unit tests.
 */
const identity: FingerprintIdentity = {
  id: "11111111-1111-4111-8111-111111111111",
  seed: 123456,
  platform: "windows",
  screenWidth: 2560,
  screenHeight: 1440,
  hardwareConcurrency: 12,
  deviceMemoryGb: 16,
  timezone: "America/Toronto",
  locale: "en-US",
  createdAt: new Date().toISOString(),
};

describe("personaConfig", () => {
  it("maps every identity field to the fury schema v1 keys", () => {
    const cfg = personaConfig(identity) as Record<string, Record<string, unknown>>;
    expect(cfg.schema_version).toBe(1);
    expect(cfg.navigator).toMatchObject({
      hardwareConcurrency: 12,
      deviceMemory: 16,
      platform: "Win32",
    });
    expect(cfg.screen).toMatchObject({
      width: 2560,
      height: 1440,
      colorDepth: 24,
      devicePixelRatio: 1,
    });
    expect(cfg.locale).toEqual({
      timezone: "America/Toronto",
      locale: "en-US",
    });
    expect(cfg.automation).toEqual({ hideTraces: true });
  });

  it("derives stable, distinct noise seeds from the identity seed", () => {
    const a = personaConfig(identity) as { noise: Record<string, number> };
    const b = personaConfig(identity) as { noise: Record<string, number> };
    expect(a.noise).toEqual(b.noise); // deterministic
    const seeds = Object.values(a.noise);
    expect(new Set(seeds).size).toBe(seeds.length); // distinct per surface
  });

  it("maps platforms to Chromium navigator.platform values", () => {
    const p = (platform: FingerprintIdentity["platform"]) =>
      (
        personaConfig({ ...identity, platform }) as {
          navigator: { platform: string };
        }
      ).navigator.platform;
    expect(p("windows")).toBe("Win32");
    expect(p("macos")).toBe("MacIntel");
    expect(p("linux")).toBe("Linux x86_64");
  });

  it("declares only the schema version when there is no identity", () => {
    expect(personaConfig(null)).toEqual({ schema_version: 1 });
  });
});

describe("resolveFuryBinary", () => {
  it("returns null when nothing is installed", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "queuepilot-fury-"));
    expect(resolveFuryBinary(dir)).toBeNull();
  });

  it("finds the newest verified receipt with a present binary", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "queuepilot-fury-"));
    const installDir = path.join(dir, "engines", "fury-core", "0.5.1", "windows-x64");
    fs.mkdirSync(path.join(installDir, "Fury"), { recursive: true });
    fs.writeFileSync(path.join(installDir, "Fury", "chrome.exe"), "fake");
    fs.writeFileSync(
      path.join(installDir, "install.json"),
      JSON.stringify({
        kind: "fury-core",
        version: "0.5.1",
        platform: "windows-x64",
        sha256: "a".repeat(64),
        url: "https://example.com/fury.tar.xz",
        installedAt: new Date().toISOString(),
        dir: installDir,
        binaryPath: "Fury/chrome.exe",
      }),
    );
    expect(resolveFuryBinary(dir)).toBe(path.join(installDir, "Fury", "chrome.exe"));
  });

  it("ignores receipts whose binary is missing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "queuepilot-fury-"));
    const installDir = path.join(dir, "engines", "fury-core", "0.5.1", "windows-x64");
    fs.mkdirSync(installDir, { recursive: true });
    fs.writeFileSync(
      path.join(installDir, "install.json"),
      JSON.stringify({
        kind: "fury-core",
        version: "0.5.1",
        platform: "windows-x64",
        sha256: "a".repeat(64),
        url: "https://example.com/fury.tar.xz",
        installedAt: new Date().toISOString(),
        dir: installDir,
        binaryPath: "Fury/chrome.exe",
      }),
    );
    expect(resolveFuryBinary(dir)).toBeNull();
  });
});
