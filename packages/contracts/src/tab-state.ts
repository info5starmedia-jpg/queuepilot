import { z } from "zod";

/**
 * J3a — tab state (Jancy's Tab object, A-3). In QueuePilot a Deck tab IS a
 * profile (ADR-0008), so this state belongs to the profile and survives runs
 * and restarts: passcodes, notes, the data extractors write (queue position,
 * cart timer…), priority, colour, subtitle, timezone override and the last
 * resolved codes. Passwords are never stored here — they stay in the secret
 * store and are resolved on demand.
 */

export const ResolvedValueSchema = z.object({
  value: z.string().max(2000),
  timestamp: z.string().datetime().nullable().default(null),
  isError: z.boolean().default(false),
});
export type ResolvedValue = z.infer<typeof ResolvedValueSchema>;

export const PasscodeSchema = z.object({
  value: z.string().min(1).max(200),
  used: z.boolean().default(false),
});

/** Data keys: short identifiers; never prototype names. */
const DataKey = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/, "a short key like queuePosition")
  .refine((k) => !["__proto__", "constructor", "prototype"].includes(k), "reserved key");

const HexColour = z.string().regex(/^#[0-9a-fA-F]{6}$/, "a colour like #3366ff");

export const TabStateSchema = z.object({
  passcodes: z.array(PasscodeSchema).max(100).default([]),
  notes: z.string().max(4000).default(""),
  /** Free data, mostly written by site extractors (J6): queuePosition, cartTimer, eventName… */
  data: z
    .record(DataKey, z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]))
    .refine((d) => Object.keys(d).length <= 50, "at most 50 data keys")
    .default({}),
  priority: z.number().int().min(-1_000_000).max(1_000_000_000).nullable().default(null),
  priorityGroup: z.string().max(60).nullable().default(null),
  colour: HexColour.nullable().default(null),
  subtitle: z.string().max(200).nullable().default(null),
  /** IANA zone override for this tab's pages; null = follow the proxy. */
  timezone: z.string().max(64).regex(/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/).nullable().default(null),
  /** Last resolved codes (email / SMS / other). Never a password. */
  codes: z
    .object({
      emailCode: ResolvedValueSchema.nullable().default(null),
      smsCode: ResolvedValueSchema.nullable().default(null),
      otherCode: ResolvedValueSchema.nullable().default(null),
    })
    .default({}),
});
export type TabState = z.infer<typeof TabStateSchema>;

/** PATCH body: any subset; `data` keys merge (a null value deletes the key). */
export const TabStatePatchSchema = z
  .object({
    passcodes: z.array(PasscodeSchema).max(100),
    notes: z.string().max(4000),
    data: z.record(DataKey, z.union([z.string().max(2000), z.number(), z.boolean(), z.null()])),
    priority: z.number().int().min(-1_000_000).max(1_000_000_000).nullable(),
    priorityGroup: z.string().max(60).nullable(),
    colour: HexColour.nullable(),
    subtitle: z.string().max(200).nullable(),
    timezone: z.string().max(64).regex(/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/).nullable(),
  })
  .partial()
  .strict();
export type TabStatePatch = z.infer<typeof TabStatePatchSchema>;

/**
 * Jancy's bulk set: one line per tab, in the order of `profileIds`. For
 * passcodes a comma gives that tab several. `repeat` cycles the lines when
 * there are more tabs than lines; without it, extra tabs are left alone.
 */
export const TabStateBulkSchema = z
  .object({
    profileIds: z.array(z.string().uuid()).min(1).max(500),
    field: z.enum(["passcodes", "notes"]),
    lines: z.array(z.string().max(4000)).min(1).max(500),
    repeat: z.boolean().default(false),
  })
  .strict();
export type TabStateBulk = z.infer<typeof TabStateBulkSchema>;
