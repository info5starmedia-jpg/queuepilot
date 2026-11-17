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

describe("generateIdentity host-memory clamp", () => {
  // V8's heap limit reveals real RAM to page JS, so a persona claiming more
  // memory than the host ships is flagged by consistency checkers (measured:
  // AliasMode "deviceMemory 4 · heap 4.09 GiB" warning on a 32 GB host,
  // 2026-11-16). When the caller passes host RAM, the claim must fit under it.
  it("never claims more memory than the host has", () => {
    // 4 GB host: the only honest claim is 4.
    for (let seed = 1; seed < 500; seed += 7) {
      expect(
        generateIdentity("windows", "UTC", "en-US", seed, null, 4).deviceMemoryGb,
      ).toBe(4);
    }
    // Non-Windows pool reaches 32; an 8 GB host must never draw 16/32.
    for (let seed = 1; seed < 500; seed += 7) {
      expect(
        generateIdentity("macos", "UTC", "en-US", seed, null, 8).deviceMemoryGb,
      ).toBeLessThanOrEqual(8);
    }
  });

  it("an 8+ GB host never claims 4 — the V8 heap cap makes it incoherent", () => {
    // Measured 2026-11-16 on our build (32 GB host): "deviceMemory 4 · heap
    // 4.09 GiB". On >= 8 GB hosts the heap cap exceeds a 4 GB claim, so the
    // smallest coherent bucket is 8. Deterministic and stable across seeds.
    // The Windows pool tops out at 8, so >= 8 GB hosts always claim 8; the
    // wider non-Windows pool may draw 8 or 16 — anything above the heap cap.
    for (let seed = 1; seed < 500; seed += 7) {
      expect(generateIdentity("windows", "UTC", "en-US", seed, null, 8).deviceMemoryGb).toBe(8);
      expect(generateIdentity("windows", "UTC", "en-US", seed, null, 32).deviceMemoryGb).toBe(8);
      const mac = generateIdentity("macos", "UTC", "en-US", seed, null, 16).deviceMemoryGb;
      expect(mac).toBeGreaterThan(4);
      expect(mac).toBeLessThanOrEqual(16);
    }
  });

  it("stays deterministic for a given seed + host memory", () => {
    const a = generateIdentity("windows", "UTC", "en-US", 4242, null, 16);
    const b = generateIdentity("windows", "UTC", "en-US", 4242, null, 16);
    expect(a.deviceMemoryGb).toBe(b.deviceMemoryGb);
    expect(a.hardwareConcurrency).toBe(b.hardwareConcurrency);
  });
});
