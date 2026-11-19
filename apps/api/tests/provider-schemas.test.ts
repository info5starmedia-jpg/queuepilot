import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ResolverRegistry, registerBuiltinResolvers, resolveSiteFieldForUrl } from "../src/application/resolvers/resolver-registry.js";
import { ParserRegistry } from "../src/application/parsers/parser-registry.js";
import { registerBuiltinParsers } from "../src/application/parsers/builtin-parsers.js";
import { loadProviderSchemas, pick } from "../src/application/resolvers/provider-schemas.js";

/**
 * J2 — SMS / password provider connectors as schema files. The two schemas
 * below are EXAMPLES of the shape (a provider's real endpoints come from its
 * own API docs in the owner's dashboard); the fetch is faked.
 */

const SMS_SCHEMA = {
  name: "smsbox",
  kind: "sms",
  request: { method: "GET", url: "https://api.smsbox.example/v1/messages?number={smsNumberFull}&limit=20", headers: { Authorization: "Bearer {key}" } },
  response: { messages: "data.messages", text: "body", date: "received_at" },
};
const PW_SCHEMA = {
  name: "pwvault",
  kind: "password",
  request: { method: "POST", url: "https://pw.example/api/accounts/search", headers: { "x-api-key": "{key}" }, body: { email: "{email}", company: "{arg1}" } },
  response: { match: { array: "accounts", field: "siteId", equals: "{siteId}", value: "password" } },
  siteIds: { ticketmaster: "92", axs: "276" },
};

function setup(schemas: Record<string, unknown>, reply: (url: string, init: RequestInit) => unknown) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qp-prov-"));
  for (const [f, s] of Object.entries(schemas)) fs.writeFileSync(path.join(dir, f), typeof s === "string" ? s : JSON.stringify(s));
  const parsers = new ParserRegistry(path.join(dir, "parsers"));
  registerBuiltinParsers(parsers);
  const reg = new ResolverRegistry();
  registerBuiltinResolvers(reg);
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(reply(url, init)));
  }) as typeof fetch;
  const load = loadProviderSchemas(dir, reg, { parsers, smsMaxAgeMin: () => 10 });
  return { reg, calls, load, f };
}

const now = new Date().toISOString();
const old = new Date(Date.now() - 3600_000).toISOString();

describe("SMS provider schema", () => {
  it("registers under its own name and returns the code via the SMS parser (Jancy grammar)", async () => {
    const { reg, calls, load, f } = setup({ "smsbox.json": SMS_SCHEMA }, () => ({
      data: { messages: [
        { body: "Your Ticketmaster code is wrong format 999", received_at: now },
        { body: "411733 is your Ticketmaster code.", received_at: now },
        { body: "000000 is your Ticketmaster code.", received_at: old },
      ] },
    }));
    expect(load).toEqual({ loaded: ["smsbox"], errors: [] });
    const v = await reg.resolve("smsbox:KEY1", {
      fetch: f, siteKind: "ticketmaster", field: "smscode", profile: { smsNumber: "2223334444", smsNumberCountryCode: "1" },
    });
    expect(v).toBe("411733");
    expect(calls[0]!.url).toBe("https://api.smsbox.example/v1/messages?number=12223334444&limit=20");
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer KEY1");
  });

  it("uses a named SMS parser, the age window, and Jancy's errors", async () => {
    const google = setup({ "smsbox.json": SMS_SCHEMA }, () => ({ data: { messages: [{ body: "G-928862 is your Google verification code.", received_at: now }] } }));
    const ctx = { fetch: google.f, field: "smscode", profile: { smsNumber: "2223334444" } };
    expect(await google.reg.resolve("smsbox:K:google", ctx)).toBe("928862");
    expect(await google.reg.resolve("smsbox:K", { ...ctx, profile: {} })).toBe("#NO SMS NUMBER");
    expect(await google.reg.resolve("smsbox", ctx)).toMatch(/^#NO API KEY/);
    expect(await google.reg.resolve("smsbox:K:nope", ctx)).toBe("#NO PARSER nope");
    const stale = setup({ "smsbox.json": SMS_SCHEMA }, () => ({ data: { messages: [{ body: "411733 is your Ticketmaster code.", received_at: old }] } }));
    expect(await stale.reg.resolve("smsbox:K", { ...ctx, fetch: stale.f })).toBe("#FILTERED MSG");
  });

  it("CSV values are URL-encoded and can never change the request host", async () => {
    const { reg, calls, f } = setup({ "smsbox.json": SMS_SCHEMA }, () => ({ data: { messages: [] } }));
    await reg.resolve("smsbox:K", { fetch: f, field: "smscode", profile: { smsNumber: "1@evil.example/x?" } });
    expect(new URL(calls[0]!.url).host).toBe("api.smsbox.example");
  });
});

describe("password provider schema", () => {
  it("POSTs the templated body and picks the account for the page's site id", async () => {
    const { reg, calls, f } = setup({ "pwvault.json": PW_SCHEMA }, () => ({
      accounts: [{ siteId: "276", password: "axs-pass" }, { siteId: "92", password: "tm-pass" }],
    }));
    const out = await resolveSiteFieldForUrl(
      { Ticketmaster: "password=pwvault:@pw:ACME" },
      "https://www.ticketmaster.com/",
      "password",
      { fetch: f, email: "fan@example.com" },
      reg,
      { get: (k: string) => (k === "pw" ? "PWKEY" : null) } as never,
    );
    expect(out).toMatchObject({ found: true, value: "tm-pass" });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ email: "fan@example.com", company: "ACME" });
    expect((calls[0]!.init.headers as Record<string, string>)["x-api-key"]).toBe("PWKEY");
  });

  it("#NO ACCOUNT when no item matches the site, #NO PASSWORD when the list is empty", async () => {
    const none = setup({ "pwvault.json": PW_SCHEMA }, () => ({ accounts: [{ siteId: "9", password: "sg" }] }));
    expect(await none.reg.resolve("pwvault:K:A", { fetch: none.f, siteKind: "ticketmaster" })).toBe("#NO ACCOUNT");
    const empty = setup({ "pwvault.json": PW_SCHEMA }, () => ({ accounts: [] }));
    expect(await empty.reg.resolve("pwvault:K:A", { fetch: empty.f, siteKind: "ticketmaster" })).toBe("#NO PASSWORD");
  });
});

describe("schema loading", () => {
  it("refuses bad files without taking the good ones down", () => {
    const { load } = setup(
      {
        "ok.json": SMS_SCHEMA,
        "clash.json": { ...SMS_SCHEMA, name: "gmail" },
        "plain.json": { ...SMS_SCHEMA, name: "plainhttp", request: { url: "http://api.example/x" } },
        "broken.json": "{ not json",
      },
      () => ({}),
    );
    // gmail is not registered in this test registry, so use a builtin name collision:
    expect(load.loaded).toContain("smsbox");
    expect(load.errors.map((e) => e.file).sort()).toEqual(["broken.json", "plain.json"]);
    expect(load.errors.find((e) => e.file === "plain.json")!.error).toMatch(/https/);
  });

  it("refuses a schema that would shadow a built-in resolver", () => {
    const { load } = setup({ "w.json": { ...SMS_SCHEMA, name: "webhook" } }, () => ({}));
    expect(load.errors[0]).toMatchObject({ file: "w.json" });
    expect(load.errors[0]!.error).toMatch(/already exists/);
  });

  it("pick() reads dotted paths with indexes", () => {
    expect(pick({ a: { b: [{ c: 1 }, { c: 2 }] } }, "a.b[1].c")).toBe(2);
    expect(pick([1, 2], "$")).toEqual([1, 2]);
    expect(pick({ a: 1 }, "x.y")).toBeUndefined();
  });
});

describe("audit follow-ups (J2)", () => {
  const aliases = { get: (k: string) => ({ key1: "SECRET-KEY-1", other: "OTHER-SECRET-9" } as Record<string, string>)[k] ?? null } as never;
  it("a stored secret may only be the key; provider error text never echoes it", async () => {
    const echo = setup({ "pwvault.json": { ...PW_SCHEMA, response: { ...PW_SCHEMA.response, error: "error" } } }, () => ({ error: "invalid key SECRET-KEY-1 for company OTHER-SECRET-9" }));
    expect(await echo.reg.resolve("pwvault:@key1:@other", { fetch: echo.f, siteKind: "ticketmaster" }, aliases)).toMatch(
      /^#BAD ALIAS stored secrets may only be the pwvault API key/,
    );
    const v = await echo.reg.resolve("pwvault:@key1:ACME", { fetch: echo.f, siteKind: "ticketmaster" }, aliases);
    expect(v).toBe("#ERROR invalid key *** for company OTHER-SECRET-9");
  });

  it("'..' cannot move the URL path; line breaks never reach a header", async () => {
    const dots = { ...SMS_SCHEMA, name: "dots", request: { ...SMS_SCHEMA.request, url: "https://api.smsbox.example/v1/{arg1}/messages", headers: { "x-email": "{email}" } } };
    const { reg, calls, f } = setup({ "dots.json": dots }, () => ({ data: { messages: [] } }));
    await reg.resolve("dots:K:..", { fetch: f, profile: { smsNumber: "1" } });
    expect(calls[0]!.url).toBe("https://api.smsbox.example/v1/%2E%2E/messages");
    expect(await reg.resolve("dots:K:x", { fetch: f, email: "a@b.com\r\nX-Evil: 1", profile: { smsNumber: "1" } })).toMatch(/line break/);
  });
});
