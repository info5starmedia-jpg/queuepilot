import {
  DomainError,
  ErrorCodes,
  StoredCreditCardSchema,
  type Profile,
  type StoredCreditCard,
} from "@queuepilot/contracts";
import type { SecretStore } from "../secrets/secret-store.js";
import { personaFieldsOf } from "./persona-fields.js";

/**
 * Credit-card PAN custody (audit v0.15.0, rec #4).
 *
 * Before this module, full card numbers AND CVVs rode inside
 * `profile.extra.creditCards` in SQLite plaintext — and every
 * `GET /profiles/:id` (or a team bundle export) handed them out raw; the
 * masked `/cards` endpoint was decoration, not a boundary.
 *
 * The rule now:
 *  - WRITES (persona PATCH, provider CSV import) carry the full card shape;
 *    `sealCardsInExtra` moves the PAN into the SecretStore (DPAPI) and keeps
 *    only last4 + fill metadata in the row.
 *  - CVVs are DISCARDED on write and never stored anywhere — an autofill
 *    fill simply has no CVV to type (the panel reports it honestly).
 *  - READS are safe by construction: the row cannot leak what it no longer
 *    holds. Autofill re-hydrates the PAN at fill time via
 *    `resolveCardForFill`.
 *  - `migrateLegacyCardStorage` lifts PANs out of pre-v0.15 rows at boot and
 *    purges the CVVs that were sitting in SQLite.
 */

export function cardSecretKey(profileId: string, set: string): string {
  return `card:${profileId}:${set}:number`;
}

function last4Of(number: string): string {
  return number.replace(/\D/g, "").slice(-4);
}

function metadataOf(
  set: string,
  number: string,
  raw: Record<string, unknown>,
): StoredCreditCard {
  return StoredCreditCardSchema.parse({
    set,
    last4: last4Of(number),
    expDate: raw.expDate ?? null,
    name: raw.name ?? null,
    address: raw.address ?? null,
    address2: raw.address2 ?? null,
    city: raw.city ?? null,
    state: raw.state ?? null,
    zip: raw.zip ?? null,
    note: raw.note ?? null,
  });
}

function setNamesOf(extra: Record<string, unknown> | null): Set<string> {
  const raw = (extra ?? {}).creditCards;
  const out = new Set<string>();
  if (!Array.isArray(raw)) return out;
  for (const item of raw) {
    if (item && typeof item === "object") {
      const set = (item as Record<string, unknown>).set;
      if (typeof set === "string" && set) out.add(set);
    }
  }
  return out;
}

/**
 * Seal the credit-card sets in `nextExtra`: full-card entries (with `number`)
 * have their PAN stored under the profile's key and are replaced by metadata
 * entries; entries already sealed pass through untouched. Sets that existed
 * in `prevExtra` but not in `nextExtra` have their secrets pruned. Without a
 * SecretStore the PAN cannot remain in SQLite plaintext either — metadata
 * only (last4 preserved), matching the store-less test contexts.
 */
export function sealCardsInExtra(
  profileId: string,
  prevExtra: Record<string, unknown> | null,
  nextExtra: Record<string, unknown> | null,
  secrets?: SecretStore,
): Record<string, unknown> {
  const bag = { ...(nextExtra ?? {}) };
  const raw = bag.creditCards;
  if (raw === undefined) return bag;

  // Prune secrets for sets the new bag no longer carries.
  if (secrets) {
    const next = setNamesOf(bag);
    for (const set of setNamesOf(prevExtra)) {
      if (!next.has(set)) secrets.delete(cardSecretKey(profileId, set));
    }
  }

  if (!Array.isArray(raw)) {
    bag.creditCards = [];
    return bag;
  }
  const out: unknown[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const c = item as Record<string, unknown>;
    const set = typeof c.set === "string" ? c.set.trim() : "";
    if (!set || seen.has(set)) continue;
    seen.add(set);
    if (typeof c.number === "string" && c.number.trim() !== "") {
      secrets?.set(cardSecretKey(profileId, set), c.number);
      out.push(metadataOf(set, c.number, c));
    } else if (typeof c.last4 === "string") {
      out.push(StoredCreditCardSchema.parse(c)); // already sealed
    }
    // Anything else (e.g. a card with neither number nor last4) is dropped.
  }
  bag.creditCards = out;
  return bag;
}

/** Full fillable card: stored metadata + PAN re-hydrated from the store. */
export function resolveCardForFill(
  profileId: string,
  extra: Record<string, unknown> | null,
  set: string,
  secrets?: SecretStore,
): StoredCreditCard & { number: string; cvv: string } {
  const stored = personaFieldsOf(extra).creditCards.find((c) => c.set === set);
  if (!stored) {
    throw new DomainError(
      ErrorCodes.CONFLICT,
      `profile has no credit-card set named "${set}"`,
    );
  }
  return {
    ...stored,
    number: secrets?.get(cardSecretKey(profileId, set)) ?? "",
    // CVVs are never stored (audit v0.15.0) — fills simply have no CVV.
    cvv: "",
  };
}

/** Clone support: the copy gets its own PAN keys (or metadata-only if absent). */
export function copyCardSecrets(
  fromProfileId: string,
  toProfileId: string,
  extra: Record<string, unknown> | null,
  secrets?: SecretStore,
): void {
  if (!secrets) return;
  for (const card of personaFieldsOf(extra).creditCards) {
    const pan = secrets.get(cardSecretKey(fromProfileId, card.set));
    if (pan !== null) secrets.set(cardSecretKey(toProfileId, card.set), pan);
  }
}

/**
 * Boot-time migration for pre-v0.15 rows: any profile whose extra still
 * carries full card numbers gets sealed (PAN → store, CVV purged). Returns
 * the number of rows migrated.
 */
export function migrateLegacyCardStorage(
  rows: Profile[],
  persist: (p: Profile) => void,
  secrets?: SecretStore,
): number {
  let migrated = 0;
  for (const p of rows) {
    const raw = (p.extra ?? {}).creditCards;
    if (!Array.isArray(raw)) continue;
    const hasLegacy = raw.some(
      (c) =>
        c &&
        typeof c === "object" &&
        typeof (c as Record<string, unknown>).number === "string" &&
        (c as Record<string, unknown>).number !== "",
    );
    if (!hasLegacy) continue;
    persist({ ...p, extra: sealCardsInExtra(p.id, p.extra, p.extra, secrets) });
    migrated++;
  }
  return migrated;
}
