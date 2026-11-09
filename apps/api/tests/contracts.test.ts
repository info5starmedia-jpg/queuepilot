import { describe, expect, it } from "vitest";
import { proxyUrl, ProfileSchema, CreateProxyInputSchema } from "@queuepilot/contracts";
import { generateIdentity, seedFraction } from "../src/application/profiles/fingerprint-generator.js";

describe("contracts", () => {
  it("proxyUrl embeds credentials only when present", () => {
    expect(
      proxyUrl({ type: "socks5", host: "h", port: 1080, username: "u", password: "p w" }),
    ).toBe("socks5://u:p%20w@h:1080");
    expect(proxyUrl({ type: "http", host: "h", port: 8080, username: null })).toBe(
      "http://h:8080",
    );
  });

  it("CreateProxyInputSchema rejects nonsense ports", () => {
    expect(() =>
      CreateProxyInputSchema.parse({ name: "x", type: "http", host: "h", port: 70000 }),
    ).toThrow();
  });

  it("ProfileSchema round-trips a persisted profile shape", () => {
    const now = new Date().toISOString();
    const p = ProfileSchema.parse({
      id: "3f6b0e62-2c2c-4c2c-9c2c-2c2c2c2c2c2c",
      name: "roundtrip",
      group: "default",
      proxyId: null,
      identityId: null,
      status: "idle",
      notes: "",
      tags: [],
      createdAt: now,
      updatedAt: now,
    });
    expect(p.name).toBe("roundtrip");
  });
});

describe("fingerprint generator", () => {
  it("is deterministic for a fixed seed (every field except id/timestamp)", () => {
    const a = generateIdentity("windows", "UTC", "en-US", 42);
    const b = generateIdentity("windows", "UTC", "en-US", 42);
    const strip = (i: typeof a) => {
      const { id: _id, createdAt: _createdAt, ...derived } = i;
      return derived;
    };
    expect(strip(a)).toEqual(strip(b));
  });

  it("only emits coherent hardware combos", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const i = generateIdentity("windows", "UTC", "en-US", seed);
      // 4 GB machines never claim 16+ cores; memory tiers bound core counts.
      if (i.deviceMemoryGb === 4) expect(i.hardwareConcurrency).toBeLessThanOrEqual(4);
      if (i.hardwareConcurrency >= 16) expect(i.deviceMemoryGb).toBeGreaterThanOrEqual(16);
    }
  });

  it("caps Windows deviceMemory at 8 GB (Chrome 157 detection measurement)", () => {
    // Independent measurement (Fury team, 2026-11-05): on Chrome 157, fresh
    // Windows profiles with deviceMemory 16 were flagged 3/3 by
    // demo.fingerprint.com while 8 GB was flagged 0/6. Windows identities
    // must stay at 4/8 GB until this is understood.
    for (let seed = 1; seed <= 500; seed++) {
      const i = generateIdentity("windows", "UTC", "en-US", seed);
      expect(i.deviceMemoryGb).toBeLessThanOrEqual(8);
    }
  });

  it("seedFraction stays in [0,1)", () => {
    for (let s = 0; s < 1000; s += 7) {
      const f = seedFraction(s, 123);
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(1);
    }
  });
});
