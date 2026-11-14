import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  totpCode,
  normalizeTotpSeed,
  totpSecretKey,
  TotpService,
} from "../src/application/profiles/totp.service.js";
import { makeTestContext, MapSecretStore } from "./helpers.js";

/** RFC 6238 Appendix B test key: ASCII "12345678901234567890", SHA-1. */
const RFC_SEED_B32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("totpCode (RFC 6238)", () => {
  it("matches the published SHA-1 6-digit vectors", () => {
    // 59s → 287082, 1111111109s → 081804, 1111111111s → 050471,
    // 1234567890s → 005924, 2000000000s → 279037 (all 6-digit truncations)
    expect(totpCode(RFC_SEED_B32, new Date(59_000))).toBe("287082");
    expect(totpCode(RFC_SEED_B32, new Date(1_111_111_109_000))).toBe("081804");
    expect(totpCode(RFC_SEED_B32, new Date(1_111_111_111_000))).toBe("050471");
    expect(totpCode(RFC_SEED_B32, new Date(1_234_567_890_000))).toBe("005924");
    expect(totpCode(RFC_SEED_B32, new Date(2_000_000_000_000))).toBe("279037");
  });

  it("is stable within a step and changes across steps", () => {
    const t1 = new Date(1_234_567_890_000);
    const t2 = new Date(1_234_567_890_000 + 15_000); // same 30s window
    const t3 = new Date(1_234_567_890_000 + 30_000); // next window
    expect(totpCode(RFC_SEED_B32, t1)).toBe(totpCode(RFC_SEED_B32, t2));
    expect(totpCode(RFC_SEED_B32, t1)).not.toBe(totpCode(RFC_SEED_B32, t3));
  });

  it("normalizeTotpSeed accepts authenticator formatting, rejects garbage", () => {
    expect(normalizeTotpSeed("gezd gnbv gy3t qojq gezd gnbv gy3t qojq")).toBe(RFC_SEED_B32);
    expect(() => normalizeTotpSeed("abc12389")).toThrow(/base32/);
    expect(() => normalizeTotpSeed("")).toThrow(/base32/);
  });
});

describe("TotpService", () => {
  it("seed is write-only: set, read code, never expose the seed; remove works", () => {
    const { profiles } = makeTestContext();
    const p = profiles.create({ name: "totp-me", generateFingerprint: true });
    const secrets = new MapSecretStore();
    const totp = new TotpService(profiles, secrets);

    expect(() => totp.current(p.id)).toThrow(/no TOTP seed/);
    totp.setSeed(p.id, ` ${RFC_SEED_B32.toLowerCase()} `);
    expect(secrets.get(totpSecretKey(p.identityId!))).toBe(RFC_SEED_B32);
    const now = totp.current(p.id);
    expect(now.code).toMatch(/^\d{6}$/);
    expect(now.secondsRemaining).toBeGreaterThan(0);
    expect(now.secondsRemaining).toBeLessThanOrEqual(30);

    totp.removeSeed(p.id);
    expect(() => totp.current(p.id)).toThrow(/no TOTP seed/);
  });

  it("profile without identity is refused loudly", () => {
    const { profiles } = makeTestContext();
    const p = profiles.create({ name: "no-id" });
    const totp = new TotpService(profiles, new MapSecretStore());
    expect(() => totp.setSeed(p.id, RFC_SEED_B32)).toThrow(/identity/);
  });
});

describe("TOTP import column", () => {
  it("CSV/Sheets 'TOTP' column lands in the SecretStore keyed by identity, never in extra", async () => {
    const { profileProviders, profiles, secrets } = makeTestContext();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qp-totp-import-"));
    const csv = path.join(dir, "in.csv");
    fs.writeFileSync(
      csv,
      [
        "Profile,Name,Email,TOTP",
        `acct-1,Alice,alice@example.com,${RFC_SEED_B32}`,
      ].join("\r\n"),
    );
    const created = await profileProviders.create({
      name: "totp-source",
      sourcePath: csv,
    });
    expect(created.refresh.imported).toBe(1);

    const profile = profiles.list().find((p) => p.providerKey === "acct-1")!;
    expect(secrets.get(totpSecretKey(profile.identityId!))).toBe(RFC_SEED_B32);
    // the profile row and extra bag must NOT carry the seed
    expect(JSON.stringify(profile.extra)).not.toContain(RFC_SEED_B32);
    expect(JSON.stringify(profile)).not.toContain(RFC_SEED_B32);
  });
});
