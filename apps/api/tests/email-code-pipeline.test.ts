import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ResolverRegistry,
  registerBuiltinResolvers,
  resolveSiteFieldForUrl,
} from "../src/application/resolvers/resolver-registry.js";
import { registerGmailResolver } from "../src/application/resolvers/gmail-resolver.js";
import { registerImapResolver } from "../src/application/resolvers/imap-resolver.js";
import { ParserRegistry, type MailMessage, type ParserArgs } from "../src/application/parsers/parser-registry.js";
import { registerBuiltinParsers, sixDigitCode } from "../src/application/parsers/builtin-parsers.js";
import {
  parseRawMail,
  runEmailCodePipeline,
  type EmailCodeSettings,
  type EmailTransport,
} from "../src/application/email/code-pipeline.js";
import type { ImapClientLike } from "../src/application/email/imap-flow-transport.js";
import { GoogleAuthService, GMAIL_SCOPE } from "../src/application/google/google-auth.service.js";
import { MapSecretStore } from "./helpers.js";

/**
 * J1 slice B — the resolver → parser pipeline (parity defect D-1) and the
 * Jancy forms `gmail:acct[:parser[:label]]` / `imap:host:port:user:pass:parser`.
 */

const EMAIL = "fan@example.com";

function rfc822(opts: { to?: string; from?: string; subject: string; body: string; date?: Date }): string {
  return [
    `From: ${opts.from ?? "Ticketmaster <customer_support@email.ticketmaster.com>"}`,
    `To: ${opts.to ?? EMAIL}`,
    `Subject: ${opts.subject}`,
    `Date: ${(opts.date ?? new Date()).toUTCString()}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    opts.body,
  ].join("\r\n");
}

const TM_MAIL = rfc822({
  subject: "Here's Your Authentication Code",
  body: "Hi Fan,\r\nYour authentication code is 482915. It expires in 10 minutes.\r\nOrder 2024-1000",
});

function tmArgs(overrides: Partial<ParserArgs> = {}): ParserArgs {
  return {
    resolverName: "gmail",
    resolverArgs: [],
    field: "emailcode",
    site: "ticketmaster",
    profile: { email: EMAIL },
    email: EMAIL,
    ...overrides,
  };
}

function registry(): ParserRegistry {
  const r = new ParserRegistry(fs.mkdtempSync(path.join(os.tmpdir(), "qp-parsers-")));
  registerBuiltinParsers(r);
  return r;
}

function fakeTransport(msgs: MailMessage[], name: "gmail" | "imap" = "gmail"): EmailTransport & { queries: unknown[] } {
  const queries: unknown[] = [];
  return {
    resolverName: name,
    queries,
    async fetch(q) {
      queries.push(q);
      return msgs;
    },
  };
}

describe("email-code pipeline", () => {
  it("defaults to the ticketmaster parser, uses its query, returns the code", async () => {
    const t = fakeTransport([await parseRawMail(TM_MAIL, "m1")]);
    const v = await runEmailCodePipeline({
      parsers: registry(), parserName: undefined, args: tmArgs(), transport: t, max: 1, newerThan: "disabled",
    });
    expect(v).toBe("482915");
    expect(t.queries[0]).toBe(
      `{subject:"Here's Your Authentication Code" subject:"Your request to reset password"} to:${EMAIL}`,
    );
  });

  it("names every failure the Jancy way", async () => {
    const reg = registry();
    const base = { parsers: reg, args: tmArgs(), max: 1, newerThan: "disabled" as const };
    expect(await runEmailCodePipeline({ ...base, parserName: "nope", transport: fakeTransport([]) })).toBe("#NO PARSER nope");
    expect(await runEmailCodePipeline({ ...base, parserName: "sms-google", transport: fakeTransport([]) })).toMatch(/^#BAD PARSER/);
    expect(
      await runEmailCodePipeline({ ...base, parserName: undefined, args: tmArgs({ site: "axs" }), transport: fakeTransport([]) }),
    ).toBe("#BAD PARSER ticketmaster");
    expect(await runEmailCodePipeline({ ...base, parserName: undefined, transport: fakeTransport([]) })).toBe("#NO MSG");
    const unrelated = await parseRawMail(rfc822({ subject: "Weekly deals", body: "nothing here" }), "x");
    expect(await runEmailCodePipeline({ ...base, parserName: undefined, transport: fakeTransport([unrelated]) })).toBe(
      "#PARSE FAILED",
    );
    const failing: EmailTransport = { resolverName: "gmail", fetch: async () => { throw new Error("#OAUTH ERROR a"); } };
    expect(await runEmailCodePipeline({ ...base, parserName: undefined, transport: failing })).toBe("#OAUTH ERROR a");
  });

  it("honours 'only return emails newer than' with #FILTERED MSG", async () => {
    const old = await parseRawMail(TM_MAIL.replace(/^Date: .*$/m, `Date: ${new Date(Date.now() - 3 * 3600_000).toUTCString()}`), "old");
    const base = { parsers: registry(), parserName: undefined, args: tmArgs(), max: 1 };
    expect(await runEmailCodePipeline({ ...base, transport: fakeTransport([old]), newerThan: "2h" })).toBe("#FILTERED MSG");
    expect(await runEmailCodePipeline({ ...base, transport: fakeTransport([old]), newerThan: "disabled" })).toBe("482915");
  });

  it("walks candidates newest first and takes the first that parses", async () => {
    const reset = await parseRawMail(
      rfc822({ subject: "Your request to reset password", body: "Use code 771122 to reset." }),
      "r",
    );
    const v = await runEmailCodePipeline({
      parsers: registry(), parserName: undefined, args: tmArgs(), max: 3, newerThan: "disabled",
      transport: fakeTransport([await parseRawMail(rfc822({ subject: "Weekly deals", body: "123456" }), "a"), reset]),
    });
    expect(v).toBe("771122");
  });

  it("keeps v1 .mjs parsers working (body alias, {email} args)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qp-parsers-v1-"));
    fs.writeFileSync(
      path.join(dir, "legacy.mjs"),
      `export default { kind: "email-parser", name: "legacy",
         canRun: (a) => !!a.email,
         getQuery: (a) => "to:" + a.email,
         parseMessage: (m) => (/code is (\\d{6})/.exec(m.body) || [])[1] || null };`,
    );
    const reg = new ParserRegistry(dir);
    await reg.rescan();
    const t = fakeTransport([await parseRawMail(TM_MAIL, "m")]);
    const v = await runEmailCodePipeline({
      parsers: reg, parserName: "legacy", args: tmArgs(), transport: t, max: 1, newerThan: "disabled",
    });
    expect(v).toBe("482915");
    expect(t.queries[0]).toBe(`to:${EMAIL}`);
  });
});

describe("builtin parsers", () => {
  it("smsdeliverer-ticketmaster reads the docs' published example", async () => {
    const msg = await parseRawMail(
      rfc822({
        subject: "SMS",
        body: "Sender: 77598\r\nReceiver: 12223334444\r\nTimestamp: 2/4/2023 5:49:02 PM\r\n411733 is your Ticketmaster code.",
      }),
      "s",
    );
    const reg = registry();
    const args = tmArgs({ profile: { smsNumber: "2223334444" } });
    expect(reg.get("smsdeliverer-ticketmaster")!.def.canRun!(args)).toBe(true);
    expect(reg.get("smsdeliverer-ticketmaster")!.def.getQuery!(args)).toBe(
      "(+(Receiver:) +(12223334444) +(is your Ticketmaster code))",
    );
    expect(reg.get("smsdeliverer-ticketmaster")!.def.parseMessage(msg, args)).toBe("411733");
  });

  it("SMS parsers take the message text (Jancy contract)", () => {
    const reg = registry();
    expect(reg.run("sms-google", { subject: "", from: "", body: "G-928862 is your Google verification code." })).toEqual({
      ok: true, code: "928862",
    });
    expect(reg.run("sms-ticketmaster", { subject: "", from: "", body: "411733 is your Ticketmaster code." })).toEqual({
      ok: true, code: "411733",
    });
  });

  it("refuses a profile email that could widen the Gmail search", () => {
    const tm = registry().get("ticketmaster")!.def;
    for (const email of ['a@b.com OR label:x', 'a"@b.com', "{a@b.com}", "(a@b.com)"]) {
      expect(tm.canRun!(tmArgs({ profile: { email } }))).toBe(false);
    }
    expect(tm.canRun!(tmArgs())).toBe(true);
  });

  it("an @alias secret containing ':' stays one positional arg", async () => {
    const reg = new ResolverRegistry();
    let seen: string[] = [];
    reg.register("probe", async (_a, ctx) => {
      seen = ctx.resolverArgs ?? [];
      return "ok";
    });
    const aliases = { get: (k: string) => (k === "imappw" ? "p@ss:w0rd" : null) } as never;
    await reg.resolve("probe:host:993:me@x.com:@imappw:ticketmaster", {}, aliases);
    expect(seen).toEqual(["host", "993", "me@x.com", "p@ss:w0rd", "ticketmaster"]);
  });

  it("sixDigitCode prefers the code next to 'code' and ignores longer numbers", () => {
    expect(sixDigitCode("Order 1234567 placed. Your code: 482915")).toBe("482915");
    expect(sixDigitCode("Ref 20241000123")).toBeNull();
  });

  it("user rescans keep builtins", async () => {
    const reg = registry();
    await reg.rescan();
    expect(reg.get("ticketmaster")).not.toBeNull();
    expect(reg.list().find((p) => p.name === "ticketmaster")).toMatchObject({ source: "builtin", kind: "email-parser" });
  });
});

describe("gmail resolver — Jancy form gmail:<account>[:<parser>[:<label>]]", () => {
  function setup(settings?: Partial<EmailCodeSettings>) {
    const secrets = new MapSecretStore();
    secrets.set(
      "google.oauth.me",
      JSON.stringify({ accessToken: "tok", refreshToken: "r", expiresAt: new Date(Date.now() + 3600_000).toISOString(), scope: GMAIL_SCOPE }),
    );
    const google = new GoogleAuthService({
      secrets, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "qp-g-")), clientId: "c", clientSecret: "s", redirectUri: "http://127.0.0.1:0/cb",
    });
    const reg = new ResolverRegistry();
    registerBuiltinResolvers(reg);
    registerGmailResolver(reg, google, {
      parsers: registry(),
      settings: () => ({ gmailMaxPerRequest: 1, gmailNewerThan: "disabled", imapNewerThan: "disabled", ...settings }),
    });
    return reg;
  }
  const ctx = { email: EMAIL, siteKind: "ticketmaster" as const, field: "emailcode" };

  it("lists with the parser query + INBOX, fetches RAW, returns the code", async () => {
    const seen: string[] = [];
    const f = (async (url: string) => {
      seen.push(url);
      if (url.includes("/messages?")) return new Response(JSON.stringify({ messages: [{ id: "g1" }] }));
      return new Response(JSON.stringify({ raw: Buffer.from(TM_MAIL).toString("base64url"), internalDate: String(Date.now()) }));
    }) as typeof fetch;
    expect(await setup().resolve("gmail:me", { ...ctx, fetch: f })).toBe("482915");
    expect(seen[0]).toContain("labelIds=INBOX");
    expect(decodeURIComponent(seen[0]!)).toContain(`to:${EMAIL}`);
    expect(seen[1]).toContain("/messages/g1?format=raw");
  });

  it("resolves a label by name, #BAD LABEL when missing", async () => {
    const seen: string[] = [];
    const f = (async (url: string) => {
      seen.push(url);
      if (url.endsWith("/labels")) return new Response(JSON.stringify({ labels: [{ id: "Label_7", name: "tm" }] }));
      if (url.includes("/messages?")) return new Response(JSON.stringify({ messages: [] }));
      return new Response("{}");
    }) as typeof fetch;
    expect(await setup().resolve("gmail:me:ticketmaster:tm", { ...ctx, fetch: f })).toBe("#NO MSG");
    expect(seen[1]).toContain("labelIds=Label_7");
    expect(await setup().resolve("gmail:me:ticketmaster:nolabel", { ...ctx, fetch: f })).toBe("#BAD LABEL nolabel");
  });

  it("#BAD ACCT for an unknown account, #OAUTH ERROR on 401", async () => {
    expect(await setup().resolve("gmail:ghost", ctx)).toBe("#BAD ACCT ghost");
    const denied = (async () => new Response("no", { status: 401 })) as typeof fetch;
    expect(await setup().resolve("gmail:me", { ...ctx, fetch: denied })).toBe("#OAUTH ERROR me");
  });

  it("the ?query= form still returns the raw body (scripts)", async () => {
    const f = (async (url: string) =>
      url.includes("/messages?")
        ? new Response(JSON.stringify({ messages: [{ id: "m" }] }))
        : new Response(JSON.stringify({ payload: { mimeType: "text/plain", body: { data: Buffer.from("raw body 1").toString("base64url") } } }))) as typeof fetch;
    expect(await setup().resolve("gmail:me?query=is:unseen", { ...ctx, fetch: f })).toBe("raw body 1");
  });
});

describe("imap resolver — Jancy form imap:<host>:<port>:<user>:<pass>:<parser>", () => {
  function fakeImap(mails: string[], opts: { failConnect?: boolean } = {}) {
    const searches: unknown[] = [];
    const creds: unknown[] = [];
    const factory = (c: unknown): ImapClientLike => {
      creds.push(c);
      return {
        async connect() { if (opts.failConnect) throw new Error("Invalid credentials (Failure) pw-secret"); },
        async getMailboxLock() { return { release() {} }; },
        async search(q) { searches.push(q); return mails.map((_, i) => i + 1); },
        async fetchOne(uid) { return { source: Buffer.from(mails[Number(uid) - 1]!), internalDate: new Date() }; },
        async logout() {},
      };
    };
    return { factory, searches, creds };
  }
  function setup(imap: ReturnType<typeof fakeImap>, accounts?: { forEmail(e: string): never | null }) {
    const reg = new ResolverRegistry();
    registerBuiltinResolvers(reg);
    registerImapResolver(reg, { parsers: registry(), imapClientFactory: imap.factory, ...(accounts ? { accounts } : {}) });
    return reg;
  }
  const ctx = { email: EMAIL, siteKind: "ticketmaster" as const, field: "emailcode" };

  it("passes the parser's ImapFlow SearchObject through and returns the code", async () => {
    const imap = fakeImap([TM_MAIL]);
    expect(await setup(imap).resolve("imap:imap.gmail.com:993:me@gmail.com:apppass:ticketmaster", ctx)).toBe("482915");
    expect(imap.searches[0]).toEqual({
      to: EMAIL,
      or: [{ subject: "Here's Your Authentication Code" }, { subject: "Your request to reset password" }],
    });
    expect(imap.creds[0]).toMatchObject({ host: "imap.gmail.com", port: 993, tls: true, user: "me@gmail.com", pass: "apppass" });
  });

  it("#BAD ARG COUNT, #CONN ERROR (password redacted)", async () => {
    expect(await setup(fakeImap([])).resolve("imap:host:993:user:pass", ctx)).toMatch(/^#BAD ARG COUNT/);
    const v = await setup(fakeImap([], { failConnect: true })).resolve("imap:h:993:u:pw-secret:ticketmaster", ctx);
    expect(v).toMatch(/^#CONN ERROR/);
    expect(v).not.toContain("pw-secret");
  });

  it("stored account + parser: imap:<email>:<parser>", async () => {
    const imap = fakeImap([TM_MAIL]);
    const accounts = {
      forEmail: (e: string) =>
        (e === "me@gmail.com" ? { host: "imap.gmail.com", port: 993, tls: true, user: e, pass: "stored" } : null) as never,
    };
    expect(await setup(imap, accounts).resolve("imap:me@gmail.com:ticketmaster", ctx)).toBe("482915");
    expect(imap.creds[0]).toMatchObject({ pass: "stored" });
    expect(await setup(imap, accounts).resolve("imap:other@gmail.com:ticketmaster", ctx)).toMatch(/^#BAD ACCT/);
  });

  it("end to end: a Site:Ticketmaster column with an imap emailcode resolves on a TM page", async () => {
    const reg = setup(fakeImap([TM_MAIL]));
    const out = await resolveSiteFieldForUrl(
      { Ticketmaster: "password=$pw, emailcode=imap:imap.gmail.com:993:me@gmail.com:app:ticketmaster" },
      "https://auth.ticketmaster.com/as/authorization",
      "emailcode",
      { email: EMAIL },
      reg,
    );
    expect(out).toMatchObject({ found: true, value: "482915" });
  });
});
