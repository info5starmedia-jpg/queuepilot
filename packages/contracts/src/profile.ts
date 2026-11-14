import { z } from "zod";

/**
 * Fingerprint identity contract.
 *
 * An identity is IMMUTABLE once created: a profile points at one identity at a
 * time, and "changing the fingerprint" means generating a new identity and
 * re-pointing the profile atomically. Mutable fingerprints are how accounts
 * get linked across sessions.
 */
export const FingerprintPlatformSchema = z.enum(["windows", "macos", "linux"]);
export type FingerprintPlatform = z.infer<typeof FingerprintPlatformSchema>;

export const FingerprintIdentitySchema = z.object({
  id: z.string().uuid(),
  /** Deterministic seed; every fingerprint value derives from it. */
  seed: z.number().int().positive(),
  platform: FingerprintPlatformSchema,
  screenWidth: z.number().int().min(800).max(7680),
  screenHeight: z.number().int().min(600).max(4320),
  hardwareConcurrency: z.number().int().min(2).max(64),
  deviceMemoryGb: z.union([z.literal(4), z.literal(8), z.literal(16), z.literal(32)]),
  timezone: z.string().min(1),
  locale: z.string().min(2),
  createdAt: z.string().datetime(),
});
export type FingerprintIdentity = z.infer<typeof FingerprintIdentitySchema>;

export const ProfileStatusSchema = z.enum(["idle", "running", "error"]);
export type ProfileStatus = z.infer<typeof ProfileStatusSchema>;

export const ProfileSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(120),
  group: z.string().max(120).default("default"),
  proxyId: z.string().uuid().nullable(),
  identityId: z.string().uuid().nullable(),
  status: ProfileStatusSchema,
  notes: z.string().max(4000).default(""),
  tags: z.array(z.string().min(1).max(60)).max(24).default([]),
  /** Login/contact email — required on provider-imported profiles. */
  email: z.string().nullable().default(null),
  /** Which provider imported this profile, and its stable key there. */
  providerId: z.string().uuid().nullable().default(null),
  providerKey: z.string().nullable().default(null),
  /**
   * Provider-imported data that doesn't map to core fields: address, DOB,
   * phone, SMS numbers, passcodes, free columns, card sets, tab color, URL,
   * timezone, favorite. Shape: ImportedProfile minus key/name/email.
   */
  extra: z.record(z.unknown()).default({}),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Profile = z.infer<typeof ProfileSchema>;

export const CreateProfileInputSchema = z.object({
  name: z.string().min(1).max(120),
  group: z.string().max(120).optional(),
  proxyId: z.string().uuid().nullable().optional(),
  notes: z.string().max(4000).optional(),
  tags: z.array(z.string().min(1).max(60)).max(24).optional(),
  platform: FingerprintPlatformSchema.optional(),
  /** Persona coherence hints (IANA names); defaults UTC / en-US. */
  timezone: z.string().max(64).optional(),
  locale: z.string().max(32).optional(),
  generateFingerprint: z.boolean().default(true),
});
export type CreateProfileInput = z.input<typeof CreateProfileInputSchema>;

export const UpdateProfileInputSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    group: z.string().max(120).optional(),
    proxyId: z.string().uuid().nullable().optional(),
    notes: z.string().max(4000).optional(),
    tags: z.array(z.string().min(1).max(60)).max(24).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "at least one field is required" });
export type UpdateProfileInput = z.input<typeof UpdateProfileInputSchema>;
