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

/**
 * Operator-pinned fields (v0.15.1, Jancy "edit fingerprint" gap). A partial
 * bag: whatever is present OVERRIDES the seed-derived value on read; the
 * seed itself is never pinned (it is the identity anchor regenerate relies
 * on). UA / WebGL / fonts are NOT here on purpose — the fury persona schema
 * derives them from platform + seed at the engine; pinning them needs an
 * engine-side knob, not a lie in storage.
 */
export const FingerprintIdentityOverridesSchema = FingerprintIdentitySchema.pick({
  platform: true,
  screenWidth: true,
  screenHeight: true,
  hardwareConcurrency: true,
  deviceMemoryGb: true,
  timezone: true,
  locale: true,
}).partial().strict();
export type FingerprintIdentityOverrides = z.infer<typeof FingerprintIdentityOverridesSchema>;

export const FingerprintIdentityWithOverridesSchema = FingerprintIdentitySchema.extend({
  /** Pins currently in effect; absent = fully seed-derived. */
  overrides: FingerprintIdentityOverridesSchema.nullable().optional(),
});
export type FingerprintIdentityWithOverrides = z.infer<typeof FingerprintIdentityWithOverridesSchema>;
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
  /** Soft-delete marker (v0.15.1); absent/null = live, timestamp = trashed. */
  deletedAt: z.string().datetime().nullable().optional(),
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
 * One named credit-card set as WRITTEN (Jancy's `CC Number:<set>` /
 * `CC CVV:<set>` columns, persona PATCH, provider CSV import). The full PAN
 * in this shape is sealed into the SecretStore on write — see
 * `StoredCreditCardSchema` for what the profile row keeps.
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

/**
 * What a credit-card set looks like IN STORAGE (audit v0.15.0): the profile
 * row keeps last4 + fill metadata only. The full PAN lives in the
 * SecretStore (DPAPI) under `card:<profileId>:<set>:number`; CVVs are
 * discarded on write and never stored anywhere.
 */
export const StoredCreditCardSchema = z.object({
  set: z.string().min(1).max(60),
  last4: z.string().max(4).default(""),
  expDate: z.string().max(10).nullable().default(null),
  name: z.string().max(120).nullable().default(null),
  address: z.string().max(200).nullable().default(null),
  address2: z.string().max(200).nullable().default(null),
  city: z.string().max(80).nullable().default(null),
  state: z.string().max(80).nullable().default(null),
  zip: z.string().max(20).nullable().default(null),
  note: z.string().max(500).nullable().default(null),
});
export type StoredCreditCard = z.infer<typeof StoredCreditCardSchema>;

/** Last-applied outer window geometry (A3 tiling "remember" feature). */
export const PersonaWindowBoundsSchema = z.object({
  left: z.number().int().min(-10000).max(10000),
  top: z.number().int().min(-10000).max(10000),
  width: z.number().int().min(200).max(10000),
  height: z.number().int().min(200).max(10000),
});
export type PersonaWindowBounds = z.infer<typeof PersonaWindowBoundsSchema>;

export const PersonaFieldsSchema = z.object({
  address: PersonaAddressSchema.nullable().default(null),
  dob: z.string().max(40).nullable().default(null),
  phone: z.string().max(40).nullable().default(null),
  smsNumbers: z.array(PersonaSmsNumberSchema).max(50).default([]),
  passcodes: z.array(z.string().max(200)).max(50).default([]),
  /** Jancy "Free 1 … Free 10" arbitrary columns. */
  free: z.record(z.string(), z.string().max(4000)).default({}),
  /**
   * Named credit-card sets as stored: last4 + metadata only (v0.15.0 audit
   * hardening — PANs moved to the SecretStore, CVVs never stored).
   */
  creditCards: z.array(StoredCreditCardSchema).max(20).default([]),
  /**
   * Per-profile proxy list (Jancy's proxies column): "host:port:user:pass",
   * "host:port", optional "scheme://" prefix, or the magic value
   * "system connection". `extra.proxyIndex` selects the current entry.
   */
  proxies: z.array(z.string().min(1).max(500)).max(50).default([]),
  /** Jancy favorite column — surfaces first in panels, filterable. */
  favorite: z.boolean().default(false),
  /** Jancy tab-color column; #rgb or #rrggbb, null = default chrome color. */
  tabColor: z
    .string()
    .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/)
    .nullable()
    .default(null),
  /** Last-applied window geometry (tiling presets remember it per profile). */
  windowBounds: PersonaWindowBoundsSchema.nullable().default(null),
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
    /** Jancy favorite column. */
    favorite: z.boolean().optional(),
    /** Jancy tab-color column (#rgb/#rrggbb, null clears). */
    tabColor: z
      .string()
      .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/)
      .nullable()
      .optional(),
    /**
     * Well-known 2FA fields (see PERSONA_WELL_KNOWN_FIELDS), stored in
     * `extra.fields`. Values may be literals OR resolver specs (`webhook:…`,
     * `@alias`, …) — resolved on demand by the resolve endpoint. Max 50 keys.
     */
    fields: z.record(z.string(), z.string().max(2000)).optional(),
    /**
     * Jancy URL column: pages opened automatically right after the profile
     * launches. Max 25 start pages per profile.
     */
    startUrls: z.array(z.string().url().max(4000)).max(25).optional(),
    /** Remembered window geometry (A3 tiling); null clears. */
    windowBounds: PersonaWindowBoundsSchema.nullable().optional(),
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
