import crypto from "node:crypto";
import { DomainError, ErrorCodes } from "@queuepilot/contracts";
import type { SecretStore } from "../secrets/secret-store.js";

/**
 * TOTP for personas (P7) — RFC 6238, HMAC-SHA-1, 6 digits, 30-second steps,
 * the shape every authenticator app speaks.
 *
 * The seed is a SECRET and lives in the SecretStore keyed by the profile's
 * identity (`totp.<identityId>`) — never in SQLite, never in `extra`. The
 * persona owns the seed; two profiles sharing an identity share the seed,
 * which is the honest semantics (same persona = same 2FA device).
 */

const STEP_SECONDS = 30;
const CODE_DIGITS = 6;

export function totpSecretKey(identityId: string): string {
  return `totp.${identityId}`;
}

/** Canonical form: uppercase, no spaces, validated base32. */
export function normalizeTotpSeed(seed: string): string {
  const cleaned = seed.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z2-7]+$/.test(cleaned)) {
    throw new DomainError(
      ErrorCodes.VALIDATION_FAILED,
      "TOTP seed must be base32 (letters A-Z and digits 2-7, as printed by authenticator apps)",
    );
  }
  return cleaned;
}

function base32Decode(input: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of input) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) continue; // padding / separators already stripped
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** The code for a moment in time. Pure function — trivially testable. */
export function totpCode(seed: string, at: Date = new Date()): string {
  const key = base32Decode(normalizeTotpSeed(seed));
  const counter = Math.floor(at.getTime() / 1000 / STEP_SECONDS);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac("sha1", key).update(msg).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    (digest[offset + 1]! << 16) |
    (digest[offset + 2]! << 8) |
    digest[offset + 3]!;
  return String(binary % 10 ** CODE_DIGITS).padStart(CODE_DIGITS, "0");
}

export function totpSecondsRemaining(at: Date = new Date()): number {
  return STEP_SECONDS - (Math.floor(at.getTime() / 1000) % STEP_SECONDS);
}

export class TotpService {
  constructor(
    private readonly profiles: { get(id: string): { identityId: string | null } },
    private readonly secrets: SecretStore,
  ) {}

  private identityOf(profileId: string): string {
    const profile = this.profiles.get(profileId);
    if (!profile) {
      throw new DomainError(ErrorCodes.PROFILE_NOT_FOUND, `profile ${profileId} not found`);
    }
    if (!profile.identityId) {
      throw new DomainError(
        ErrorCodes.VALIDATION_FAILED,
        "profile has no fingerprint identity — generate one before attaching a TOTP seed",
      );
    }
    return profile.identityId;
  }

  setSeed(profileId: string, seed: string): void {
    this.secrets.set(totpSecretKey(this.identityOf(profileId)), normalizeTotpSeed(seed));
  }

  hasSeed(profileId: string): boolean {
    return this.secrets.get(totpSecretKey(this.identityOf(profileId))) !== null;
  }

  removeSeed(profileId: string): void {
    this.secrets.delete(totpSecretKey(this.identityOf(profileId)));
  }

  /** Current code + rollover countdown for the profile's persona. */
  current(profileId: string, at: Date = new Date()): { code: string; secondsRemaining: number } {
    const seed = this.secrets.get(totpSecretKey(this.identityOf(profileId)));
    if (!seed) {
      throw new DomainError(
        ErrorCodes.VALIDATION_FAILED,
        "no TOTP seed for this profile — PUT one first (base32, from the authenticator app)",
      );
    }
    return { code: totpCode(seed, at), secondsRemaining: totpSecondsRemaining(at) };
  }
}
