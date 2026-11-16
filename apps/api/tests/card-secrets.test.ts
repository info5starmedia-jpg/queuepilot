import { describe, expect, it } from "vitest";
import {
  cardSecretKey,
  copyCardSecrets,
  migrateLegacyCardStorage,
  resolveCardForFill,
  sealCardsInExtra,
} from "../src/application/profiles/card-secrets.js";
import { personaFieldsOf } from "../src/application/profiles/persona-fields.js";
import { MapSecretStore } from "./helpers.js";
import type { Profile } from "@queuepilot/contracts";

/**
 * Credit-card PAN custody (audit rec #4, v0.15.0): PANs sealed into the
 * SecretStore on write, CVVs discarded, reads metadata-only.
 */

const FULL_CARD = {
  set: "personal",
  number: "4242 4242 4242 4242",
  cvv: "123",
  expDate: "12/28",
  name: "J Doe",
  address: null,
  address2: null,
  city: null,
  state: null,
  zip: null,
  note: null,
};

function profileWith(extra: Record<string, unknown>, id = "p1"): Profile {
  return {
    id,
    name: "p",
    group: "default",
    proxyId: null,
    identityId: null,
    status: "idle",
    notes: "",
    tags: [],
    email: null,
    providerId: null,
    providerKey: null,
    extra,
    createdAt: "2026-11-16T00:00:00.000Z",
    updatedAt: "2026-11-16T00:00:00.000Z",
  };
}

describe("sealCardsInExtra", () => {
  it("moves the PAN to the store and keeps metadata in the row", () => {
    const secrets = new MapSecretStore();
    const out = sealCardsInExtra("p1", {}, { creditCards: [FULL_CARD] }, secrets);
    const cards = personaFieldsOf(out).creditCards;
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ set: "personal", last4: "4242", expDate: "12/28" });
    expect(cards[0]).not.toHaveProperty("number");
    expect(cards[0]).not.toHaveProperty("cvv");
    expect(secrets.get(cardSecretKey("p1", "personal"))).toBe("4242 4242 4242 4242");
    // the CVV never lands anywhere
    expect(JSON.stringify(out)).not.toContain("123");
  });

  it("keeps other persona keys untouched", () => {
    const out = sealCardsInExtra(
      "p1",
      {},
      { phone: "555", creditCards: [FULL_CARD] },
      new MapSecretStore(),
    );
    expect(out.phone).toBe("555");
  });

  it("without a store the PAN is dropped, not kept in plaintext", () => {
    const out = sealCardsInExtra("p1", {}, { creditCards: [FULL_CARD] });
    const cards = personaFieldsOf(out).creditCards;
    expect(cards[0]).toMatchObject({ set: "personal", last4: "4242" });
    expect(JSON.stringify(out)).not.toContain("4242424242424242");
  });

  it("is idempotent over already-sealed metadata", () => {
    const secrets = new MapSecretStore();
    const once = sealCardsInExtra("p1", {}, { creditCards: [FULL_CARD] }, secrets);
    const twice = sealCardsInExtra("p1", once, once, secrets);
    expect(personaFieldsOf(twice).creditCards[0]).toMatchObject({ set: "personal", last4: "4242" });
  });

  it("prunes the secret when a set is removed", () => {
    const secrets = new MapSecretStore();
    const prev = sealCardsInExtra("p1", {}, { creditCards: [FULL_CARD] }, secrets);
    expect(secrets.get(cardSecretKey("p1", "personal"))).not.toBeNull();
    const next = sealCardsInExtra("p1", prev, { creditCards: [] }, secrets);
    expect(personaFieldsOf(next).creditCards).toEqual([]);
    expect(secrets.get(cardSecretKey("p1", "personal"))).toBeNull();
  });
});

describe("resolveCardForFill", () => {
  it("re-hydrates the PAN from the store and never returns a CVV", () => {
    const secrets = new MapSecretStore();
    const extra = sealCardsInExtra("p1", {}, { creditCards: [FULL_CARD] }, secrets);
    const card = resolveCardForFill("p1", extra, "personal", secrets);
    expect(card.number).toBe("4242 4242 4242 4242");
    expect(card.cvv).toBe("");
    expect(card.last4).toBe("4242");
  });

  it("409s on an unknown set", () => {
    expect(() => resolveCardForFill("p1", {}, "ghost", new MapSecretStore())).toThrow(
      /no credit-card set named "ghost"/,
    );
  });
});

describe("copyCardSecrets (clone)", () => {
  it("the clone fills under its own profile id", () => {
    const secrets = new MapSecretStore();
    const extra = sealCardsInExtra("p1", {}, { creditCards: [FULL_CARD] }, secrets);
    copyCardSecrets("p1", "p2", extra, secrets);
    expect(secrets.get(cardSecretKey("p2", "personal"))).toBe("4242 4242 4242 4242");
    const card = resolveCardForFill("p2", extra, "personal", secrets);
    expect(card.number).toBe("4242 4242 4242 4242");
  });
});

describe("migrateLegacyCardStorage", () => {
  it("seals rows that still carry full PANs and purges their CVVs", () => {
    const secrets = new MapSecretStore();
    const legacy = profileWith({ creditCards: [FULL_CARD], phone: "1" });
    const clean = profileWith({ creditCards: [{ set: "x", last4: "9999" }] });
    const persisted: Profile[] = [];
    const migrated = migrateLegacyCardStorage(
      [legacy, clean],
      (p) => persisted.push(p),
      secrets,
    );
    expect(migrated).toBe(1);
    const sealed = persisted[0]!;
    expect(personaFieldsOf(sealed.extra).creditCards[0]).toMatchObject({
      set: "personal",
      last4: "4242",
    });
    expect(JSON.stringify(sealed.extra)).not.toContain("123");
    expect(secrets.get(cardSecretKey("p1", "personal"))).toBe("4242 4242 4242 4242");
    expect(sealed.extra.phone).toBe("1");
  });

  it("migrates nothing when no row carries a legacy PAN", () => {
    const persisted: Profile[] = [];
    expect(migrateLegacyCardStorage([profileWith({})], (p) => persisted.push(p))).toBe(0);
    expect(persisted).toHaveLength(0);
  });
});
