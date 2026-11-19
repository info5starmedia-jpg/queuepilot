import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ResolverRegistry, registerBuiltinResolvers, resolveSiteFieldForUrl } from "../src/application/resolvers/resolver-registry.js";
import { ParserRegistry } from "../src/application/parsers/parser-registry.js";
import { registerBuiltinParsers } from "../src/application/parsers/builtin-parsers.js";
import { redactAycdKeys, registerAycdResolver, safeAycdBase } from "../src/application/email/aycd-inbox.js";

/**
 * J1 slice C (AYCD part) — `aycd:<api-key>[:<parser>[:<templateId>]]` against
 * a fake of AYCD's Inbox API (same endpoints, auth header and shapes as
 * AYCD's public client: POST /api/v1/tasks/mail/create, GET
 * /api/v1/tasks/completed?group=…, Authorization: Token <key>).
 */

const EMAIL = "fan@example.com";
const TM = { email: EMAIL, siteKind: "ticketmaster" as const, field: "emailcode" };

type Reply = { status: string; results?: Record<string, string> } | "401";

function fakeInbox(reply: (task: Record<string, unknown>) => Reply) {
  const created: Record<string, unknown>[] = [];
  const auth: string[] = [];
  let polls = 0;
  const done: { id: string; status: string; results?: Record<string, string> }[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    auth.push(headers.authorization ?? "");
    if (url.includes("/tasks/mail/create")) {
      const task = JSON.parse(String(init!.body)) as Record<string, unknown>;
      const r = reply(task);
      if (r === "401") return new Response("unauthorized", { status: 401 });
      const id = `t${created.length + 1}`;
      created.push(task);
      done.push({ id, ...r });
      return new Response(JSON.stringify({ id }));
    }
    if (url.includes("/tasks/completed?group=")) {
      polls++;
      const tasks = done.splice(0);
      return new Response(JSON.stringify({ tasks }));
    }
    return new Response("nope", { status: 404 });
  }) as typeof fetch;
  return { f, created, auth, polls: () => polls };
}

function setup(inbox: ReturnType<typeof fakeInbox>, aliases?: Record<string, string>) {
  const parsers = new ParserRegistry(fs.mkdtempSync(path.join(os.tmpdir(), "qp-aycd-")));
  registerBuiltinParsers(parsers);
  const reg = new ResolverRegistry();
  registerBuiltinResolvers(reg);
  registerAycdResolver(reg, {
    parsers,
    settings: () => ({ lookbackMin: 10, timeoutSec: 60 }),
    client: { fetch: inbox.f, pollMs: 5 },
  });
  const store = aliases ? ({ get: (k: string) => aliases[k] ?? null } as never) : undefined;
  return { reg, store };
}

describe("aycd resolver", () => {
  it("creates a Mail Task for the profile email with the parser's filters and returns the code", async () => {
    const inbox = fakeInbox(() => ({ status: "success", results: { code: "482915", anyCode: "482915\n2024" } }));
    const { reg } = setup(inbox);
    const before = Math.floor(Date.now() / 1000);
    expect(await reg.resolve("aycd:KEY123", TM)).toBe("482915");
    const task = inbox.created[0]!;
    expect(task).toMatchObject({
      email: EMAIL,
      timeout: 60,
      mailFilters: [
        { target: "subject", comparator: "includes", value: "Here's Your Authentication Code", orValues: ["Your request to reset password"] },
      ],
    });
    expect(task.receivedAt as number).toBeLessThanOrEqual(before - 600);
    expect(task.receivedAt as number).toBeGreaterThan(before - 700);
    expect(String(task.group)).toMatch(/^queuepilot-/);
    expect(task).not.toHaveProperty("templateId");
    expect(inbox.auth.every((a) => a === "Token KEY123")).toBe(true);
  });

  it("falls back to the second result element, passes templateId", async () => {
    const inbox = fakeInbox(() => ({ status: "success", results: { code: "", anyCode: "771122" } }));
    const { reg } = setup(inbox);
    expect(await reg.resolve("aycd:K:ticketmaster:tpl-7", TM)).toBe("771122");
    expect(inbox.created[0]).toMatchObject({ templateId: "tpl-7" });
  });

  it("maps AYCD outcomes to Jancy error names", async () => {
    expect(await setup(fakeInbox(() => ({ status: "timeout" }))).reg.resolve("aycd:K", TM)).toBe("#NO MSG");
    expect(
      await setup(
        fakeInbox(() => ({ status: "error", results: { errorStatus: "invalid task template", errorMessage: "…" } })),
      ).reg.resolve("aycd:K", TM),
    ).toBe("#BAD ACCT invalid task template");
    // Real AYCD reply for an unknown address (seen live 2026-11-19).
    expect(
      await setup(fakeInbox(() => ({ status: "error", results: { errorStatus: "not found" } }))).reg.resolve("aycd:K", TM),
    ).toBe("#BAD ACCT fan@example.com is not an account in AYCD Inbox (or use a Mail Task Template id)");
    expect(await setup(fakeInbox(() => ({ status: "success", results: {} }))).reg.resolve("aycd:K", TM)).toBe("#PARSE FAILED");
    expect(await setup(fakeInbox(() => "401")).reg.resolve("aycd:K", TM)).toMatch(/^#BAD ACCT AYCD Inbox rejected the API key/);
  });

  it("refuses parsers it can't run before calling AYCD", async () => {
    const inbox = fakeInbox(() => ({ status: "success", results: { code: "1" } }));
    const { reg } = setup(inbox);
    expect(await reg.resolve("aycd:K:smsdeliverer-ticketmaster", TM)).toMatch(/^#BAD PARSER smsdeliverer-ticketmaster has no AYCD/);
    expect(await reg.resolve("aycd:K", { ...TM, siteKind: "axs" as const })).toBe("#BAD PARSER ticketmaster");
    expect(await reg.resolve("aycd:K:nope", TM)).toBe("#NO PARSER nope");
    expect(await reg.resolve("aycd", TM)).toMatch(/^#NO API KEY/);
    expect(inbox.created).toHaveLength(0);
  });

  it("takes the key from a token alias; an unknown alias is #BAD ALIAS", async () => {
    const inbox = fakeInbox(() => ({ status: "success", results: { code: "111222" } }));
    const { reg, store } = setup(inbox, { aycdkey: "SECRET-KEY" });
    expect(await reg.resolve("aycd:@aycdkey", TM, store)).toBe("111222");
    expect(inbox.auth[0]).toBe("Token SECRET-KEY");
    expect(await reg.resolve("aycd:@missing", TM, store)).toBe("#BAD ALIAS @missing");
  });

  it("concurrent resolves for the same profile share ONE Inbox task (audit: no task spam)", async () => {
    const inbox = fakeInbox(() => ({ status: "success", results: { code: "123456" } }));
    const { reg } = setup(inbox);
    const out = await Promise.all([1, 2, 3].map(() => reg.resolve("aycd:K", TM)));
    expect(out).toEqual(["123456", "123456", "123456"]);
    expect(inbox.created).toHaveLength(1);
    expect(inbox.polls()).toBeLessThanOrEqual(2);
    // A second profile is a different task.
    await Promise.all([reg.resolve("aycd:K", TM), reg.resolve("aycd:K", { ...TM, email: "two@example.com" })]);
    expect(inbox.created).toHaveLength(3);
  });

  it("end to end from a Site:Ticketmaster column on a TM page", async () => {
    const inbox = fakeInbox(() => ({ status: "success", results: { code: "654321" } }));
    const { reg } = setup(inbox);
    const out = await resolveSiteFieldForUrl(
      { Ticketmaster: "emailcode=aycd:K" },
      "https://auth.ticketmaster.com/as/authorization",
      "emailcode",
      { email: EMAIL },
      reg,
    );
    expect(out).toMatchObject({ found: true, value: "654321" });
  });
});

describe("redactAycdKeys", () => {
  it("masks inline keys, leaves aliases and other resolvers alone", () => {
    expect(redactAycdKeys("password=$x, emailcode=aycd:RAWKEY123:ticketmaster")).toBe("password=$x, emailcode=aycd:***:ticketmaster");
    expect(redactAycdKeys("emailcode=aycd:@aycd")).toBe("emailcode=aycd:@aycd");
    expect(redactAycdKeys("emailcode=gmail:me")).toBe("emailcode=gmail:me");
  });
});

describe("safeAycdBase", () => {
  it("defaults to AYCD's cloud relay and only accepts https or loopback overrides", () => {
    expect(safeAycdBase(undefined)).toBe("https://inbox-api.aycd.io");
    expect(safeAycdBase("http://127.0.0.1:7788/")).toBe("http://127.0.0.1:7788");
    expect(safeAycdBase("https://inbox.example.com/x?y=1#z")).toBe("https://inbox.example.com/x");
    expect(() => safeAycdBase("https://u:p@inbox.example.com")).toThrow(/credentials/);
    expect(safeAycdBase("https://inbox.example.com")).toBe("https://inbox.example.com");
    expect(() => safeAycdBase("http://evil.example.com")).toThrow(/https/);
    expect(() => safeAycdBase("not a url")).toThrow(/not a URL/);
  });
});

describe("AYCD key slot — /integrations/aycd", () => {
  it("stores the key as the `aycd` alias, never returns it, verifies, removes", async () => {
    const { makeTestContext } = await import("./helpers.js");
    const ctx = makeTestContext();
    const get = async () => (await ctx.app.inject({ method: "GET", url: "/integrations/aycd" })).json();
    expect(await get()).toEqual({ configured: false, alias: "aycd", usage: "emailcode=aycd:@aycd" });

    const noKey = await ctx.app.inject({ method: "POST", url: "/integrations/aycd/verify" });
    expect(noKey.statusCode).toBe(400);

    const bad = await ctx.app.inject({ method: "PUT", url: "/integrations/aycd", payload: { apiKey: "has space" } });
    expect(bad.statusCode).toBe(400);

    const put = await ctx.app.inject({ method: "PUT", url: "/integrations/aycd", payload: { apiKey: "good-aycd-key-1234" } });
    expect(put.statusCode).toBe(200);
    expect(put.body).not.toContain("good-aycd-key-1234");
    expect(await get()).toMatchObject({ configured: true });
    expect(ctx.aliases.get("aycd")).toBe("good-aycd-key-1234");

    const ok = await ctx.app.inject({ method: "POST", url: "/integrations/aycd/verify" });
    expect(ok.json()).toEqual({ ok: true, error: null });

    await ctx.app.inject({ method: "PUT", url: "/integrations/aycd", payload: { apiKey: "wrong-key-5678" } });
    expect((await ctx.app.inject({ method: "POST", url: "/integrations/aycd/verify" })).json()).toMatchObject({ ok: false });

    await ctx.app.inject({ method: "DELETE", url: "/integrations/aycd" });
    expect(await get()).toMatchObject({ configured: false });
  });
});

describe("AycdInboxClient.verify", () => {
  it("calls GET /api/v1/user/verify with the Token header; 401 → not ok", async () => {
    const { AycdInboxClient } = await import("../src/application/email/aycd-inbox.js");
    const seen: string[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      seen.push(`${url} ${(init?.headers as Record<string, string>).authorization}`);
      return new Response(url.includes("good") ? "{}" : "x", { status: seen.length === 1 ? 200 : 401 });
    }) as typeof fetch;
    const c = new AycdInboxClient("K1", { fetch: f, base: "http://127.0.0.1:1" });
    expect(await c.verify()).toEqual({ ok: true, error: null });
    expect(seen[0]).toBe("http://127.0.0.1:1/api/v1/user/verify Token K1");
    const second = await c.verify();
    expect(second.ok).toBe(false);
    expect(second.error).toMatch(/rejected the API key/);
  });
});
