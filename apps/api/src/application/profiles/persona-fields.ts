import {
  PersonaFieldsSchema,
  UpdatePersonaInputSchema,
  type PersonaFields,
  type PersonaWellKnownField,
  type UpdatePersonaInput,
} from "@queuepilot/contracts";

/**
 * Persona fields — the typed read/validate layer over the Jancy 2FA columns
 * that live in `profile.extra` (address, DOB, phone, SMS numbers, passcodes,
 * Free 1–10). Provider import writes these keys; this module is how the rest
 * of the app reads them WITHOUT trusting the bag: unknown keys are ignored,
 * malformed known keys fall back to defaults (the bag stays untouched on
 * read; a malformed value never crashes a panel render).
 *
 * Well-known 2FA fields (password/smscode/emailcode/othercode) live under
 * `extra.fields` and may hold literals OR resolver specs — see
 * `personaFieldValue`.
 */

/** Strict parse; returns null when the bag carries nothing parseable. */
export function personaFieldsOf(
  extra: Record<string, unknown> | null,
): PersonaFields {
  const bag = extra ?? {};
  const parsed = PersonaFieldsSchema.safeParse({
    address: bag.address,
    dob: bag.dob,
    phone: bag.phone,
    smsNumbers: bag.smsNumbers,
    passcodes: bag.passcodes,
    free: bag.free,
    creditCards: bag.creditCards,
    favorite: bag.favorite,
    tabColor: bag.tabColor,
  });
  if (parsed.success) return parsed.data;
  // Malformed bag: ship defaults rather than crash. The raw bag is preserved
  // verbatim on the profile — nothing is destroyed by a bad read.
  return PersonaFieldsSchema.parse({});
}

/** Merge a validated partial update into an extra bag (returns a NEW bag). */
export function mergePersonaFields(
  extra: Record<string, unknown> | null,
  input: UpdatePersonaInput,
): Record<string, unknown> {
  const patch = UpdatePersonaInputSchema.parse(input);
  return { ...(extra ?? {}), ...patch };
}

/**
 * Current SMS number under Jancy cycling: `extra.smsIndex` (an integer,
 * default 0) selects `smsNumbers[index % len]`. Rotation is a service
 * operation because it persists the new index.
 */
export function currentSms(
  fields: PersonaFields,
  smsIndex: number,
): { index: number; total: number; number: PersonaFields["smsNumbers"][number] } | null {
  if (fields.smsNumbers.length === 0) return null;
  const index = ((Math.trunc(smsIndex) % fields.smsNumbers.length) + fields.smsNumbers.length) %
    fields.smsNumbers.length;
  return { index, total: fields.smsNumbers.length, number: fields.smsNumbers[index]! };
}

function smsIndexOf(extra: Record<string, unknown> | null): number {
  const raw = (extra ?? {}).smsIndex;
  return typeof raw === "number" && Number.isFinite(raw) ? Math.trunc(raw) : 0;
}

/** Next index for one rotation step. */
export function nextSmsIndex(extra: Record<string, unknown> | null): number {
  return smsIndexOf(extra) + 1;
}

/** Raw value of a well-known 2FA field from `extra.fields` (null if unset). */
export function personaFieldValue(
  extra: Record<string, unknown> | null,
  field: PersonaWellKnownField,
): string | null {
  const fields = (extra ?? {}).fields;
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return null;
  const value = (fields as Record<string, unknown>)[field];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Does `value` look like a resolver spec? `<registered-name>:` prefix. The
 * registry decides — a literal like `pass:word` is NOT a spec when no
 * resolver named `pass` exists, so plain passwords pass through untouched.
 */
export function looksLikeSpec(value: string, registeredNames: Set<string>): boolean {
  const m = /^([A-Za-z0-9_-]{2,40}):/.exec(value);
  return m !== null && registeredNames.has(m[1]!);
}

/**
 * Mask a card number for panel reads: last 4 digits only, everything before
 * replaced by `•`. Non-digit junk (spaces, dashes) is stripped first so the
 * mask never leaks length hints beyond the last4 itself.
 */
export function maskCardNumber(number: string): string {
  const digits = number.replace(/\D/g, "");
  const last4 = digits.slice(-4);
  return last4.length === 0 ? "••••" : `•••• •••• •••• ${last4}`;
}

/** Masked, panel-safe view of a card — everything but last4 + metadata. */
export function maskCard(
  card: PersonaFields["creditCards"][number],
): Omit<typeof card, "number" | "cvv"> & { last4: string; hasCvv: boolean } {
  const { number, cvv, ...rest } = card;
  return { ...rest, last4: maskCardNumber(number), hasCvv: cvv.length > 0 };
}
