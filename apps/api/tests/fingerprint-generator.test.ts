import { describe, expect, it } from "vitest";
import { generateIdentity, seedFraction } from "../src/application/profiles/fingerprint-generator.js";

describe("generateIdentity host-display clamp", () => {
  // id (randomUUID) and createdAt are per-call by design; determinism covers
  // the seed-derived fields.
  const deterministic = (id: ReturnType<typeof generateIdentity>) => ({
    seed: id.seed,
    platform: id.platform,
    screenWidth: id.screenWidth,
    screenHeight: id.screenHeight,
    hardwareConcurrency: id.hardwareConcurrency,
    deviceMemoryGb: id.deviceMemoryGb,
    timezone: id.timezone,
    locale: id.locale,
  });

  it("still derives everything deterministically from the seed when no host is given", () => {
    const a = generateIdentity("windows", "UTC", "en-US", 12345);
    const b = generateIdentity("windows", "UTC", "en-US", 12345);
    expect(deterministic(a)).toEqual(deterministic(b));
  });

  it("never claims a screen larger than the host display", () => {
    // 1920x1080 host: the 2560x1440 candidate must never be picked.
    for (let seed = 1; seed < 500; seed += 7) {
      const id = generateIdentity("windows", "UTC", "en-US", seed, { width: 1920, height: 1080 });
      expect(id.screenWidth).toBeLessThanOrEqual(1920);
      expect(id.screenHeight).toBeLessThanOrEqual(1080);
      // Deterministic for a given seed + host.
      const again = generateIdentity("windows", "UTC", "en-US", seed, { width: 1920, height: 1080 });
      expect(deterministic(again)).toEqual(deterministic(id));
    }
  });

  it("falls back to the host's own size when no candidate fits", () => {
    const id = generateIdentity("windows", "UTC", "en-US", 999, { width: 1280, height: 720 });
    expect(id.screenWidth).toBe(1280);
    expect(id.screenHeight).toBe(720);
  });

  it("keeps candidates that fit and drops only the oversized ones", () => {
    const seen = new Set<string>();
    for (let seed = 1; seed < 2000; seed++) {
      const id = generateIdentity("windows", "UTC", "en-US", seed, { width: 1920, height: 1080 });
      seen.add(`${id.screenWidth}x${id.screenHeight}`);
    }
    expect(seen.has("1920x1080")).toBe(true);
    expect(seen.has("2560x1440")).toBe(false);
    expect(seen.size).toBeGreaterThan(1); // still samples across fitting sizes
  });

  it("seedFraction stays in [0, 1)", () => {
    for (let seed = 1; seed < 100; seed += 13) {
      const f = seedFraction(seed, 0x9e3779b9);
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(1);
    }
  });
});
