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

/**
 * Typed 2FA/persona fields — the Jancy panel's address/DOB/phone/SMS/passcode
 * columns, living in `profile.extra` under these exact keys (the same shape
 * provider import already writes). This schema is the read/validate contract:
 * the extra bag may carry anything, but these keys, when present, must parse.
 */
export const PersonaAddressSchema = z.object({
  line1: z.string().nullable().default(null),
  line2: z.string().nullable().default(null),
  city: z.string().nullable().default(null),
  state: z.string().nullable().default(null),
  zip: z.string().nullable().default(null),
});
export type PersonaAddress = z.infer<typeof PersonaAddressSchema>;

/**
 * One SMS number. Jancy's column syntax allows a country-code suffix on the
 * column name (`SMS Number 3:44` = +44); import normalizes that into
 * `countryCode`, display labels ride in `label`.
 */
export const PersonaSmsNumberSchema = z.object({
  label: z.string().max(60).default(""),
  number: z.string().min(1).max(40),
  countryCode: z.string().max(6).nullable().default(null),
});
export type PersonaSmsNumber = z.infer<typeof PersonaSmsNumberSchema>;

/**
 * One named credit-card set (Jancy's `CC Number:<set>` / `CC CVV:<set>`
 * columns). Full PANs ride in `extra.creditCards` — same shape provider
 * import writes — but panel reads go through `maskCardNumber` (last4 only).
 */
export const PersonaCreditCardSchema = z.object({
  set: z.string().min(1).max(60),
  number: z.string().min(1).max(40),
  cvv: z.string().max(8).default(""),
  expDate: z.string().max(10).nullable().default(null),
  name: z.string().max(120).nullable().default(null),
  address: z.string().max(200).nullable().default(null),
  address2: z.string().max(200).nullable().default(null),
  city: z.string().max(80).nullable().default(null),
  state: z.string().max(80).nullable().default(null),
  zip: z.string().max(20).nullable().default(null),
  note: z.string().max(500).nullable().default(null),
});
export type PersonaCreditCard = z.infer<typeof PersonaCreditCardSchema>;

export const PersonaFieldsSchema = z.object({
  address: PersonaAddressSchema.nullable().default(null),
  dob: z.string().max(40).nullable().default(null),
  phone: z.string().max(40).nullable().default(null),
  smsNumbers: z.array(PersonaSmsNumberSchema).max(50).default([]),
  passcodes: z.array(z.string().max(200)).max(50).default([]),
  /** Jancy "Free 1 … Free 10" arbitrary columns. */
  free: z.record(z.string(), z.string().max(4000)).default({}),
  /** Named credit-card sets — full PANs; read masked outside this layer. */
  creditCards: z.array(PersonaCreditCardSchema).max(20).default([]),
  /**
   * Per-profile proxy list (Jancy's proxies column): "host:port:user:pass",
   * "host:port", optional "scheme://" prefix, or the magic value
   * "system connection". `extra.proxyIndex` selects the current entry.
   */
  proxies: z.array(z.string().min(1).max(500)).max(50).default([]),
});
export type PersonaFields = z.infer<typeof PersonaFieldsSchema>;

/** Partial update — only the keys present are merged. */
export const UpdatePersonaInputSchema = z
  .object({
    address: PersonaAddressSchema.nullable().optional(),
    dob: z.string().max(40).nullable().optional(),
    phone: z.string().max(40).nullable().optional(),
    smsNumbers: z.array(PersonaSmsNumberSchema).max(50).optional(),
    passcodes: z.array(z.string().max(200)).max(50).optional(),
    free: z.record(z.string(), z.string().max(4000)).optional(),
    /** Named credit-card sets (full PANs — writes only; reads are masked). */
    creditCards: z.array(PersonaCreditCardSchema).max(20).optional(),
    /** Per-profile proxy list entries (see PersonaFieldsSchema.proxies). */
    proxies: z.array(z.string().min(1).max(500)).max(50).optional(),
    /**
     * Well-known 2FA fields (see PERSONA_WELL_KNOWN_FIELDS), stored in
     * `extra.fields`. Values may be literals OR resolver specs (`webhook:…`,
     * `@alias`, …) — resolved on demand by the resolve endpoint. Max 50 keys.
     */
    fields: z.record(z.string(), z.string().max(2000)).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "at least one field is required" })
  .refine((v) => !v.fields || Object.keys(v.fields).length <= 50, {
    message: "at most 50 well-known fields",
  });
export type UpdatePersonaInput = z.input<typeof UpdatePersonaInputSchema>;

/**
 * Well-known 2FA field names (Jancy's `password=` / `smscode=` / `emailcode=`
 * / `othercode=` columns). Values live in `extra.fields` and may be literals
 * OR resolver specs (`webhook:…`, `@alias`, …) — resolved on demand.
 */
export const PERSONA_WELL_KNOWN_FIELDS = [
  "password",
  "smscode",
  "emailcode",
  "othercode",
] as const;
export type PersonaWellKnownField = (typeof PERSONA_WELL_KNOWN_FIELDS)[number];

export const CreateProfileInputSchema = z.object({
  name: z.string().min(1).max(120),
  /** Login/contact email (Jancy's required Email column). */
  email: z.string().email().max(200).nullable().optional(),
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
    /** null clears the email; omitted leaves it unchanged. */
    email: z.string().email().max(200).nullable().optional(),
    group: z.string().max(120).optional(),
    proxyId: z.string().uuid().nullable().optional(),
    notes: z.string().max(4000).optional(),
    tags: z.array(z.string().min(1).max(60)).max(24).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "at least one field is required" });
export type UpdateProfileInput = z.input<typeof UpdateProfileInputSchema>;
