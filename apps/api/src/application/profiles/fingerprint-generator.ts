import { randomInt, randomUUID } from "node:crypto";
import type { FingerprintIdentity, FingerprintPlatform } from "@queuepilot/contracts";

/**
 * Deterministic, seed-driven fingerprint identity generation.
 *
 * The seed is the only entropy: every field derives from it, so an identity
 * can be regenerated on any machine and match byte-for-byte. Combinations are
 * drawn from sets real machines actually ship in — a fingerprint is only
 * plausible if its parts are mutually coherent (screen scale vs. resolution,
 * memory vs. core count).
 */

const SCREENS: ReadonlyArray<readonly [number, number]> = [
  [1920, 1080],
  [1536, 864],
  [1366, 768],
  [1440, 900],
  [2560, 1440],
  [1680, 1050],
];

/** Weighted like the real desktop market: 8 and 16 GB dominate. */
const MEMORY: ReadonlyArray<4 | 8 | 16 | 32> = [4, 8, 8, 8, 16, 16, 32];

/**
 * Windows-only cap, from an independent measurement published by the Fury
 * team (2026-11-05, Chrome 157, Windows build box, fresh seeds):
 * deviceMemory 16 scored 0.82–0.94 on demo.fingerprint.com and was flagged
 * 3 of 3; 8 GB scored 0.09–0.12 and was flagged 0 of 6. On Chrome 155 the
 * same 16 scored 0.10. Why 157 minds 16 is an open question, even to them.
 * Until it is understood, new Windows identities draw from 4/8 GB only.
 * (Measurement/idea only — Fury is AGPL-3.0; no code was copied.)
 */
const MEMORY_WINDOWS: ReadonlyArray<4 | 8> = [4, 8, 8, 8];

/** One well-mixed fraction in [0, 1) from a seed (Mulberry32). */
export function seedFraction(seed: number, salt: number): number {
  let m = (seed + salt) >>> 0;
  m = Math.imul(m ^ (m >>> 15), m | 1);
  m ^= m + Math.imul(m ^ (m >>> 7), m | 61);
  return ((m ^ (m >>> 14)) >>> 0) / 4294967296;
}

function pick<T>(arr: ReadonlyArray<T>, seed: number, salt: number): T {
  return arr[Math.floor(seedFraction(seed, salt) * arr.length)]!;
}

export function generateIdentity(
  platform: FingerprintPlatform,
  timezone = "UTC",
  locale = "en-US",
  seed: number = randomInt(1, 2 ** 31 - 1),
): FingerprintIdentity {
  const [w, h] = pick(SCREENS, seed, 0x9e3779b9);
  const mem = pick(platform === "windows" ? MEMORY_WINDOWS : MEMORY, seed, 0x85ebca6b);
  // Core counts that actually ship with each memory tier: a 4 GB machine
  // claiming 32 cores is a detectable incoherence.
  const coresForMem: Record<number, ReadonlyArray<number>> = {
    4: [2, 4],
    8: [4, 6, 8],
    16: [8, 12, 16],
    32: [16, 24, 32],
  };
  const cores = pick(coresForMem[mem]!, seed, 0xc2b2ae35);
  return {
    id: randomUUID(),
    seed,
    platform,
    screenWidth: w,
    screenHeight: h,
    hardwareConcurrency: cores,
    deviceMemoryGb: mem,
    timezone,
    locale,
    createdAt: new Date().toISOString(),
  };
}
