import { describe, expect, it } from "vitest";
import { makeTestContext } from "./helpers.js";

/**
 * Fingerprint field pinning (v0.15.1, Jancy's "edit fingerprint" gap).
 * Pins live in an overrides bag on the identity row: they override the
 * seed-derived values on READ (every consumer — launch snapshot, runtime
 * persona config, drift, attestation — reads through the same merge), while
 * the seed-derived row underneath stays intact so regenerate/clear still
 * works.
 */

describe("fingerprint identity overrides", () => {
  it("pins apply on read; un-pinned fields stay seed-derived", async () => {
    const ctx = makeTestContext();
    const p = ctx.profiles.create({ name: "pin", generateFingerprint: true });

    const before = ctx.profiles.identityOf(p.id)!;
    const res = await ctx.app.inject({
      method: "PATCH",
      url: `/profiles/${p.id}/identity`,
      payload: { screenWidth: 1920, screenHeight: 1080, timezone: "America/New_York" },
    });
    expect(res.statusCode).toBe(200);
    const after = res.json().identity;

    expect(after.screenWidth).toBe(1920);
    expect(after.screenHeight).toBe(1080);
    expect(after.timezone).toBe("America/New_York");
    // Untouched fields keep their seed-derived values.
    expect(after.hardwareConcurrency).toBe(before.hardwareConcurrency);
    expect(after.locale).toBe(before.locale);
    expect(after.seed).toBe(before.seed);
    // The pin bag is visible so the UI can mark pinned fields.
    expect(after.overrides).toEqual({
      screenWidth: 1920,
      screenHeight: 1080,
      timezone: "America/New_York",
    });
  });

  it("GET /profiles/:id/identity returns the effective identity", async () => {
    const ctx = makeTestContext();
    const p = ctx.profiles.create({ name: "read-back", generateFingerprint: true });
    await ctx.app.inject({
      method: "PATCH",
      url: `/profiles/${p.id}/identity`,
      payload: { hardwareConcurrency: 16, deviceMemoryGb: 32 },
    });
    const res = await ctx.app.inject({ method: "GET", url: `/profiles/${p.id}/identity` });
    expect(res.statusCode).toBe(200);
    const identity = res.json().identity;
    expect(identity.hardwareConcurrency).toBe(16);
    expect(identity.deviceMemoryGb).toBe(32);
  });

  it("empty body clears every pin back to seed-derived", async () => {
    const ctx = makeTestContext();
    const p = ctx.profiles.create({ name: "clear", generateFingerprint: true });
    const original = ctx.profiles.identityOf(p.id)!;

    await ctx.app.inject({
      method: "PATCH",
      url: `/profiles/${p.id}/identity`,
      payload: { locale: "de-DE", platform: "linux" },
    });
    let now = ctx.profiles.identityOf(p.id)!;
    expect(now.locale).toBe("de-DE");
    expect(now.platform).toBe("linux");

    const clear = await ctx.app.inject({
      method: "PATCH",
      url: `/profiles/${p.id}/identity`,
      payload: {},
    });
    now = clear.json().identity;
    expect(now.locale).toBe(original.locale);
    expect(now.platform).toBe(original.platform);
    expect(now.overrides ?? null).toBeNull();
  });

  it("seed is not pin-able — overriding it is a validation error", async () => {
    const ctx = makeTestContext();
    const p = ctx.profiles.create({ name: "no-seed", generateFingerprint: true });
    const res = await ctx.app.inject({
      method: "PATCH",
      url: `/profiles/${p.id}/identity`,
      payload: { seed: 42 },
    });
    expect(res.statusCode).toBe(400);
  });

  it("out-of-range values are rejected (schema bounds, same as generation)", async () => {
    const ctx = makeTestContext();
    const p = ctx.profiles.create({ name: "bounds", generateFingerprint: true });
    const res = await ctx.app.inject({
      method: "PATCH",
      url: `/profiles/${p.id}/identity`,
      payload: { screenWidth: 100 }, // min is 800
    });
    expect(res.statusCode).toBe(400);
  });

  it("pins ride into the launch snapshot (apply at next start semantics)", async () => {
    const ctx = makeTestContext();
    const p = ctx.profiles.create({ name: "launch", generateFingerprint: true });

    await ctx.app.inject({
      method: "PATCH",
      url: `/profiles/${p.id}/identity`,
      payload: { timezone: "Europe/Berlin", locale: "de-DE" },
    });

    const start = await ctx.app.inject({ method: "POST", url: `/profiles/${p.id}/start`, payload: {} });
    expect(start.statusCode).toBe(201);

    // The fake runtime materializes its "observed fingerprint" from the
    // identity it was handed at launch — it must be the PINNED values, not
    // the seed-derived ones.
    const session = ctx.runtime.sessions[ctx.runtime.sessions.length - 1]!;
    const observed = await session.captureFingerprint();
    expect(observed.timezone).toBe("Europe/Berlin");
    expect(observed.locale).toBe("de-DE");
  });

  it("profile without an identity gets a clear 409, not a crash", async () => {
    const ctx = makeTestContext();
    const p = ctx.profiles.create({ name: "no-identity", generateFingerprint: false });
    const res = await ctx.app.inject({
      method: "PATCH",
      url: `/profiles/${p.id}/identity`,
      payload: { timezone: "UTC" },
    });
    expect(res.statusCode).toBe(409);
  });
});
