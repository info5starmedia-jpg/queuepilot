import { z } from "zod";

/**
 * Fingerprint attestation contract.
 *
 * The ObservedFingerprint is a PHOTOGRAPH of what the live engine actually
 * reports, captured by evaluating probes inside a real page over CDP. It is
 * never an input to identity generation: the FingerprintIdentity (seed,
 * screen, platform, timezone...) is what we ask the engine for; the observed
 * fingerprint is what we got back. Attestation compares the two so drift
 * between "requested" and "materialized" is a verdict, not a hope.
 *
 * (Pattern adapted from AliasMode's attestation model — Apache-2.0. This is
 * an independent implementation against our own contracts.)
 */
export const ObservedFingerprintSchema = z.object({
  userAgent: z.string(),
  platform: z.string(),
  languages: z.array(z.string()),
  hardwareConcurrency: z.number().int().nullable(),
  deviceMemory: z.number().nullable(),
  screenWidth: z.number().int(),
  screenHeight: z.number().int(),
  colorDepth: z.number().int().nullable(),
  timezone: z.string().nullable(),
  locale: z.string().nullable(),
  webglVendor: z.string().nullable(),
  webglRenderer: z.string().nullable(),
});
export type ObservedFingerprint = z.infer<typeof ObservedFingerprintSchema>;

export const FingerprintDifferenceSchema = z.object({
  /** Identity field that disagrees with the live probe. */
  field: z.string(),
  expected: z.string().nullable(),
  observed: z.string().nullable(),
});
export type FingerprintDifference = z.infer<typeof FingerprintDifferenceSchema>;

/**
 * "unattested" = the run has no launch-snapshot identity to compare against
 * (launched without a generated identity, or a pre-snapshot run). The observed
 * photograph is still returned — it is audit data either way.
 */
export const AttestationVerdictSchema = z.enum([
  "match",
  "mismatch",
  "unattested",
]);
export type AttestationVerdict = z.infer<typeof AttestationVerdictSchema>;

export const AttestationResultSchema = z.object({
  profileId: z.string().uuid(),
  runId: z.string().uuid(),
  verdict: AttestationVerdictSchema,
  observed: ObservedFingerprintSchema,
  differences: z.array(FingerprintDifferenceSchema),
  capturedAt: z.string().datetime(),
});
export type AttestationResult = z.infer<typeof AttestationResultSchema>;
