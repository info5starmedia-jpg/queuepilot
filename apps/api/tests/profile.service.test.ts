import { describe, expect, it } from "vitest";
import { DomainError, ErrorCodes } from "@queuepilot/contracts";
import { makeTestContext } from "./helpers.js";

describe("ProfileService", () => {
  it("creates a profile with a deterministic fingerprint identity", () => {
    const { profiles } = makeTestContext();
    const p = profiles.create({ name: "alpha", generateFingerprint: true });
    expect(p.id).toBeTruthy();
    expect(p.identityId).toBeTruthy();
    expect(p.status).toBe("idle");
    expect(p.group).toBe("default");
  });

  it("creates a profile without a fingerprint when asked", () => {
    const { profiles } = makeTestContext();
    const p = profiles.create({ name: "bare", generateFingerprint: false });
    expect(p.identityId).toBeNull();
  });

  it("rejects an unknown proxy reference", () => {
    const { profiles } = makeTestContext();
    expect(() =>
      profiles.create({
        name: "x",
        generateFingerprint: false,
        proxyId: "3f6b0e62-2c2c-4c2c-9c2c-2c2c2c2c2c2c",
      }),
    ).toThrowError(DomainError);
  });

  it("regenerating a fingerprint re-points the profile and keeps history", () => {
    const { profiles } = makeTestContext();
    const p = profiles.create({ name: "regen", generateFingerprint: true });
    const firstIdentity = p.identityId;
    const next = profiles.regenerateFingerprint(p.id);
    expect(next.identityId).toBeTruthy();
    expect(next.identityId).not.toBe(firstIdentity);
  });

  it("delete on unknown profile throws PROFILE_NOT_FOUND", () => {
    const { profiles } = makeTestContext();
    try {
      profiles.delete("3f6b0e62-2c2c-4c2c-9c2c-2c2c2c2c2c2c");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).code).toBe(ErrorCodes.PROFILE_NOT_FOUND);
    }
  });
});
