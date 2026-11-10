import { describe, expect, it } from "vitest";
import type {
  FingerprintIdentity,
  ObservedFingerprint,
} from "@queuepilot/contracts";
import { compareFingerprint } from "../src/application/profiles/fingerprint-attestation.js";
import { FakeSession } from "../src/application/runtime/fake.browser-runtime.js";
import { makeTestContext } from "./helpers.js";

/**
 * Fingerprint attestation: the observed photograph of the live engine vs the
 * launch snapshot identity. Pure compare is tested without any engine; the
 * endpoint is exercised through the FakeBrowserRuntime, which "materializes"
 * the identity faithfully by default and can be tampered with to force a
 * mismatch.
 */
const identity: FingerprintIdentity = {
  id: "11111111-1111-4111-8111-111111111111",
  seed: 42,
  platform: "windows",
  screenWidth: 1920,
  screenHeight: 1080,
  hardwareConcurrency: 8,
  deviceMemoryGb: 8,
  timezone: "America/Toronto",
  locale: "en-US",
  createdAt: new Date().toISOString(),
};

function observed(overrides: Partial<ObservedFingerprint> = {}): ObservedFingerprint {
  return {
    userAgent: "FakeEngine/1.0 (windows)",
    platform: "windows",
    languages: ["en-US", "en"],
    hardwareConcurrency: 8,
    deviceMemory: 8,
    screenWidth: 1920,
    screenHeight: 1080,
    colorDepth: 24,
    timezone: "America/Toronto",
    locale: "en-US",
    webglVendor: "FakeVendor",
    webglRenderer: "FakeRenderer",
    ...overrides,
  };
}

describe("compareFingerprint (pure)", () => {
  it("returns match when observed equals the identity", () => {
    const { verdict, differences } = compareFingerprint(identity, observed());
    expect(verdict).toBe("match");
    expect(differences).toEqual([]);
  });

  it("returns unattested with no identity of record", () => {
    const { verdict, differences } = compareFingerprint(null, observed());
    expect(verdict).toBe("unattested");
    expect(differences).toEqual([]);
  });

  it("reports each disagreeing field", () => {
    const { verdict, differences } = compareFingerprint(
      identity,
      observed({ screenWidth: 2560, timezone: "Europe/Berlin" }),
    );
    expect(verdict).toBe("mismatch");
    expect(differences).toEqual([
      { field: "screenWidth", expected: "1920", observed: "2560" },
      { field: "timezone", expected: "America/Toronto", observed: "Europe/Berlin" },
    ]);
  });

  it("never manufactures a mismatch from an unobservable field", () => {
    const { verdict } = compareFingerprint(
      identity,
      observed({ deviceMemory: null, hardwareConcurrency: null }),
    );
    expect(verdict).toBe("match");
  });

  it("matches locale against the primary language, not the full list", () => {
    const { verdict } = compareFingerprint(identity, observed());
    expect(verdict).toBe("match");
    const bad = compareFingerprint(identity, observed({ languages: ["fr-FR"] }));
    expect(bad.verdict).toBe("mismatch");
    expect(bad.differences[0]?.field).toBe("locale");
  });
});

describe("GET /profiles/:id/attest", () => {
  it("attests a running profile as match", async () => {
    const ctx = makeTestContext();
    const profile = ctx.profiles.create({ name: "attest-match", generateFingerprint: true });
    await ctx.lifecycle.start(profile.id);

    const res = await ctx.app.inject({
      method: "GET",
      url: `/profiles/${profile.id}/attest`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.verdict).toBe("match");
    expect(body.observed.screenWidth).toBeGreaterThan(0);
    expect(body.runId).toBe(ctx.lifecycle.activeRun(profile.id)?.id);
  });

  it("reports mismatch when the engine materialized different values", async () => {
    const ctx = makeTestContext();
    const profile = ctx.profiles.create({ name: "attest-mismatch", generateFingerprint: true });
    const run = await ctx.lifecycle.start(profile.id);
    const identity = ctx.snapshots.forRun(run.id)?.identity;
    expect(identity).not.toBeNull();
    const session = ctx.runtime.sessions.at(-1) as FakeSession;
    // Start from the faithful default (matches the identity), tamper one field.
    const faithful = await session.captureFingerprint();
    session.observedFingerprint = {
      ...faithful,
      screenHeight: identity!.screenHeight + 360,
    };

    const res = await ctx.app.inject({
      method: "GET",
      url: `/profiles/${profile.id}/attest`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.verdict).toBe("mismatch");
    expect(body.differences).toEqual([
      {
        field: "screenHeight",
        expected: String(identity!.screenHeight),
        observed: String(identity!.screenHeight + 360),
      },
    ]);
  });

  it("returns unattested for a profile launched without an identity", async () => {
    const ctx = makeTestContext();
    const profile = ctx.profiles.create({
      name: "attest-noid",
      generateFingerprint: false,
    });
    await ctx.lifecycle.start(profile.id);

    const res = await ctx.app.inject({
      method: "GET",
      url: `/profiles/${profile.id}/attest`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().verdict).toBe("unattested");
  });

  it("returns 409 when the profile is not running", async () => {
    const ctx = makeTestContext();
    const profile = ctx.profiles.create({ name: "attest-idle" });
    const res = await ctx.app.inject({
      method: "GET",
      url: `/profiles/${profile.id}/attest`,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("PROFILE_NOT_RUNNING");
  });
});
