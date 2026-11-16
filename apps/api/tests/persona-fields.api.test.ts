import { describe, expect, it, beforeEach } from "vitest";
import { makeTestContext, type TestContext } from "./helpers.js";

/**
 * v0.14 persona-fields HTTP surface: typed PATCH of the Jancy 2FA columns
 * (address/DOB/phone/SMS/passcodes/Free + well-known fields), SMS cycling,
 * and the resolve binding — literal pass-through vs registered-resolver specs.
 */

let ctx: TestContext;
beforeEach(() => {
  ctx = makeTestContext();
});

function createProfile(name = "acct-1") {
  return ctx.profiles.create({ name, generateFingerprint: false });
}

describe("PATCH /profiles/:id/persona", () => {
  it("sets typed fields and reads them back from the extra bag", async () => {
    const p = createProfile();
    const res = await ctx.app.inject({
      method: "PATCH",
      url: `/profiles/${p.id}/persona`,
      payload: {
        address: { line1: "1 Main St", line2: null, city: "Toronto", state: "ON", zip: "M5V" },
        dob: "1990-04-12",
        phone: "+1 416 555 0100",
        smsNumbers: [
          { label: "SMS Number", number: "4165550100", countryCode: null },
          { label: "SMS Number 2:44", number: "7956123456", countryCode: "44" },
        ],
        passcodes: ["PRESALE1", "FAN2"],
        free: { "Free 1": "vip", "Free 2": "row A" },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.extra.address).toMatchObject({ city: "Toronto", zip: "M5V" });
    expect(body.extra.smsNumbers).toHaveLength(2);
    expect(body.extra.free["Free 1"]).toBe("vip");

    // Raw profile read keeps the bag.
    const got = await ctx.app.inject({ method: "GET", url: `/profiles/${p.id}` });
    expect(got.json().extra.passcodes).toEqual(["PRESALE1", "FAN2"]);
    expect(got.json().extra.dob).toBe("1990-04-12");
  });

  it("merges partially: a later patch preserves earlier persona keys", async () => {
    const p = createProfile();
    await ctx.app.inject({
      method: "PATCH",
      url: `/profiles/${p.id}/persona`,
      payload: { phone: "111", free: { "Free 1": "a" } },
    });
    await ctx.app.inject({
      method: "PATCH",
      url: `/profiles/${p.id}/persona`,
      payload: { dob: "1988-01-01" },
    });
    const got = await ctx.app.inject({ method: "GET", url: `/profiles/${p.id}` });
    expect(got.json().extra.phone).toBe("111");
    expect(got.json().extra.free["Free 1"]).toBe("a");
    expect(got.json().extra.dob).toBe("1988-01-01");
  });

  it("stores well-known 2FA field values under extra.fields", async () => {
    const p = createProfile();
    const res = await ctx.app.inject({
      method: "PATCH",
      url: `/profiles/${p.id}/persona`,
      payload: {
        fields: { password: "hunter2", smscode: "static:864213" },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().extra.fields).toEqual({ password: "hunter2", smscode: "static:864213" });
  });

  it("rejects an empty patch and a malformed payload", async () => {
    const p = createProfile();
    const empty = await ctx.app.inject({
      method: "PATCH",
      url: `/profiles/${p.id}/persona`,
      payload: {},
    });
    expect(empty.statusCode).toBe(400);
    const bad = await ctx.app.inject({
      method: "PATCH",
      url: `/profiles/${p.id}/persona`,
      payload: { smsNumbers: "not-an-array" },
    });
    expect(bad.statusCode).toBe(400);
  });

  it("404s for an unknown profile", async () => {
    const res = await ctx.app.inject({
      method: "PATCH",
      url: "/profiles/00000000-0000-4000-8000-000000000000/persona",
      payload: { phone: "1" },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /profiles/:id/sms/rotate", () => {
  it("cycles through the numbers with wraparound, persisting the index", async () => {
    const p = createProfile();
    await ctx.app.inject({
      method: "PATCH",
      url: `/profiles/${p.id}/persona`,
      payload: {
        smsNumbers: [
          { label: "SMS Number", number: "111", countryCode: null },
          { label: "SMS Number 2", number: "222", countryCode: null },
        ],
      },
    });

    const first = await ctx.app.inject({ method: "POST", url: `/profiles/${p.id}/sms/rotate` });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ index: 1, total: 2, number: "222" });

    const second = await ctx.app.inject({ method: "POST", url: `/profiles/${p.id}/sms/rotate` });
    expect(second.json()).toMatchObject({ index: 0, total: 2, number: "111" });
  });

  it("409s loudly when there is nothing to cycle", async () => {
    const p = createProfile();
    const res = await ctx.app.inject({ method: "POST", url: `/profiles/${p.id}/sms/rotate` });
    expect(res.statusCode).toBe(409);
  });

  it("404s for an unknown profile", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/profiles/00000000-0000-4000-8000-000000000000/sms/rotate",
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /profiles/:id/resolve — well-known persona fields", () => {
  it("passes literal field values through untouched", async () => {
    const p = createProfile();
    await ctx.app.inject({
      method: "PATCH",
      url: `/profiles/${p.id}/persona`,
      payload: { fields: { password: "pass:word" } }, // 'pass' is NOT a registered resolver
    });
    const res = await ctx.app.inject({
      method: "POST",
      url: `/profiles/${p.id}/resolve`,
      payload: { field: "password" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ found: true, field: "password", value: "pass:word" });
    expect(res.json().spec).toBeUndefined();
  });

  it("resolves a registered-resolver spec stored in extra.fields", async () => {
    const p = createProfile();
    await ctx.app.inject({
      method: "PATCH",
      url: `/profiles/${p.id}/persona`,
      payload: { fields: { smscode: "static:864213" } },
    });
    const res = await ctx.app.inject({
      method: "POST",
      url: `/profiles/${p.id}/resolve`,
      payload: { field: "smscode" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      found: true,
      field: "smscode",
      value: "864213",
      spec: "static:864213",
    });
  });

  it("resolves a test-registered resolver through extra.fields", async () => {
    const p = createProfile();
    ctx.resolvers.register("fakeotp", async (args) => `OTP-${args}`);
    await ctx.app.inject({
      method: "PATCH",
      url: `/profiles/${p.id}/persona`,
      payload: { fields: { emailcode: "fakeotp:7788" } },
    });
    const res = await ctx.app.inject({
      method: "POST",
      url: `/profiles/${p.id}/resolve`,
      payload: { field: "emailcode" },
    });
    expect(res.json()).toMatchObject({ found: true, value: "OTP-7788" });
  });

  it("returns found:false when the field is unset", async () => {
    const p = createProfile();
    const res = await ctx.app.inject({
      method: "POST",
      url: `/profiles/${p.id}/resolve`,
      payload: { field: "othercode" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ found: false, profileId: p.id });
  });

  it("falls through to the well-known field when the Site column misses", async () => {
    const p = createProfile();
    await ctx.app.inject({
      method: "PATCH",
      url: `/profiles/${p.id}/persona`,
      payload: { fields: { smscode: "static:999" } },
    });
    // Site "ticketmaster" has no columns at all → falls through to extra.fields.
    const res = await ctx.app.inject({
      method: "POST",
      url: `/profiles/${p.id}/resolve`,
      payload: { site: "ticketmaster", field: "smscode" },
    });
    expect(res.json()).toMatchObject({ found: true, value: "999" });
  });
});

describe("GET /profiles/:id/cards — masked card reads", () => {
  it("writes full cards via persona patch, reads only masked views", async () => {
    const p = createProfile();
    await ctx.app.inject({
      method: "PATCH",
      url: `/profiles/${p.id}/persona`,
      payload: {
        creditCards: [
          {
            set: "personal",
            number: "4242 4242 4242 4242",
            cvv: "123",
            expDate: "12/28",
            name: "J Doe",
            address: "1 Main St",
            address2: null,
            city: "Toronto",
            state: "ON",
            zip: "M5V",
            note: null,
          },
        ],
      },
    });
    const res = await ctx.app.inject({ method: "GET", url: `/profiles/${p.id}/cards` });
    expect(res.statusCode).toBe(200);
    const { cards } = res.json();
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      set: "personal",
      last4: "4242",
      hasCvv: false, // CVVs are never stored since the v0.15.0 seal
      expDate: "12/28",
    });
    expect(JSON.stringify(cards[0])).not.toContain("4242 4242 4242 4242");

    // The raw profile read cannot leak what the row no longer holds — the
    // PAN lives in the SecretStore, only last4 + metadata ride in extra.
    const raw = await ctx.app.inject({ method: "GET", url: `/profiles/${p.id}` });
    expect(JSON.stringify(raw.json())).not.toContain("4242 4242 4242 4242");
    expect(JSON.stringify(raw.json())).not.toContain("4242424242424242");
    const list = await ctx.app.inject({ method: "GET", url: "/profiles" });
    expect(JSON.stringify(list.json())).not.toContain("4242424242424242");
    expect(cards[0]).not.toHaveProperty("number");
    expect(cards[0]).not.toHaveProperty("cvv");
  });

  it("returns an empty list when no cards are set", async () => {
    const p = createProfile();
    const res = await ctx.app.inject({ method: "GET", url: `/profiles/${p.id}/cards` });
    expect(res.json()).toEqual({ cards: [] });
  });

  it("404s for an unknown profile", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: "/profiles/00000000-0000-4000-8000-000000000000/cards",
    });
    expect(res.statusCode).toBe(404);
  });
});
