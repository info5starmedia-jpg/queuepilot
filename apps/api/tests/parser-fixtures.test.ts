import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ParserRegistry, type ParserArgs } from "../src/application/parsers/parser-registry.js";
import { lookupParser, otpParser, registerBuiltinParsers } from "../src/application/parsers/builtin-parsers.js";
import { parseRawMail, runEmailCodePipeline } from "../src/application/email/code-pipeline.js";

/**
 * Ticketmaster code emails in the EXACT layout of real ones from the owner's
 * mailbox (checked 2026-11-19: auth + reset, personalised subjects, iCloud
 * Hide-My-Email senders, Outlook→Gmail forwarding). Everything personal is
 * replaced: addresses, names, codes and tracking tokens are synthetic.
 */

const TRACK = (n: number) =>
  `https://click.email.ticketmaster.com/?qs=ABB7InYiOjEsImQiOjQ5NTF9AAcAAAAA${"x".repeat(n)}Gu8iog777777Z5B2xvMeg`;

function tmMail(opts: { kind: "auth" | "reset"; code: string; to: string; from?: string; subject?: string }): string {
  const head = opts.kind === "auth"
    ? ["Confirm Your Account", "", "Please use this code to verify you are the account owner.", "", " Your Authentication Code:"]
    : ["Let's Update Your Password", "", "We received a request to reset your Ticketmaster account password.", "", " Your Reset Code:"];
  const body = [
    "Ticketmaster", "", TRACK(3), "View as a Web Page", "", TRACK(4), "", TRACK(5), "My Account", "",
    ...head, "", ` ${opts.code}`, "",
    opts.kind === "auth" ? " If you didn’t request an authentication code, please" : " If you didn't make this request, please",
    TRACK(6), "reset your password .", "", "Contact us for further assistance to protect your account.", "",
    " Thanks,", "", " Ticketmaster Fan Support", "", TRACK(7), "Privacy", "",
    " 707 Virginia Street East, Suite 170, Charleston, WV 25301", "", " (c) 2026 Ticketmaster. All rights reserved.",
  ].join("\r\n");
  return [
    `From: Ticketmaster <${opts.from ?? "customer_support@email.ticketmaster.com"}>`,
    `To: ${opts.to}`,
    `Subject: ${opts.subject ?? (opts.kind === "auth" ? "Here's Your Authentication Code" : "Your request to reset password")}`,
    `Date: ${new Date().toUTCString()}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    body,
  ].join("\r\n");
}

function reg(): ParserRegistry {
  const r = new ParserRegistry(fs.mkdtempSync(path.join(os.tmpdir(), "qp-fx-")));
  registerBuiltinParsers(r);
  return r;
}
const args = (email: string, resolverName = "gmail"): ParserArgs => ({
  resolverName, resolverArgs: [], field: "emailcode", site: "ticketmaster", profile: { email }, email,
});
const transport = (raws: string[]) => ({
  resolverName: "gmail" as const,
  fetch: async () => Promise.all(raws.map((r, i) => parseRawMail(r, `m${i}`))),
});

describe("ticketmaster parser on real-format emails (redacted)", () => {
  const cases = [
    { label: "auth code", raw: tmMail({ kind: "auth", code: "123456", to: "fan@example.com" }), email: "fan@example.com", code: "123456" },
    { label: "reset code", raw: tmMail({ kind: "reset", code: "654321", to: "fan@example.com" }), email: "fan@example.com", code: "654321" },
    {
      label: "personalised subject",
      raw: tmMail({ kind: "auth", code: "246802", to: "fan@example.com", subject: "Alex, Here's Your Authentication Code" }),
      email: "fan@example.com", code: "246802",
    },
    {
      label: "iCloud Hide My Email (rewritten sender)",
      raw: tmMail({
        kind: "auth", code: "135790", to: "quiet-otter.0x@icloud.com",
        from: "customer_support_at_email_ticketmaster_com_abc123xyz_00000000@icloud.com",
        subject: "Sam, Here's Your Authentication Code",
      }),
      email: "quiet-otter.0x@icloud.com", code: "135790",
    },
    {
      label: "Outlook account forwarded into Gmail (To kept)",
      raw: tmMail({ kind: "reset", code: "080808", to: "FanName1234@outlook.com" }),
      email: "FanName1234@outlook.com", code: "080808",
    },
  ];
  for (const c of cases) {
    it(`reads the ${c.label}, ignoring digits in tracking links`, async () => {
      const v = await runEmailCodePipeline({
        parsers: reg(), parserName: undefined, args: args(c.email), transport: transport([c.raw]), max: 1, newerThan: "disabled",
      });
      expect(v).toBe(c.code);
    });
  }

  it("the AYCD form's regex (RE2-safe) finds the same code in the same text", async () => {
    const msg = await parseRawMail(tmMail({ kind: "auth", code: "123456", to: "fan@example.com" }), "m");
    const spec = reg().get("ticketmaster")!.def.aycdTask!(args("fan@example.com", "aycd"));
    const re = new RegExp(spec.mailElements[0]!.regex!);
    expect(re.exec(msg.text)?.[1]).toBe("123456");
  });
});

describe("otp(...) generic parser", () => {
  it("parses options and builds Gmail / IMAP / AYCD forms", () => {
    const p = otpParser("otp(from=axs.com;subject=verification code;len=6)");
    if (typeof p === "string") throw new Error(p);
    const a = args("fan@example.com");
    expect(p.getQuery!(a)).toBe('from:(axs.com) subject:("verification code") to:fan@example.com');
    expect(p.getQuery!({ ...a, resolverName: "imap" })).toEqual({ from: "axs.com", subject: "verification code", to: "fan@example.com" });
    expect(p.aycdTask!({ ...a, resolverName: "aycd" }).mailFilters).toEqual([
      { target: "subject", comparator: "includes", value: "verification code" },
      { target: "from", comparator: "includes", value: "axs.com" },
    ]);
  });

  it("extracts codes of the configured length, only from matching mail", async () => {
    const mail = (subject: string, body: string, from = "AXS <noreply@axs.com>") =>
      ["From: " + from, "To: fan@example.com", `Subject: ${subject}`, `Date: ${new Date().toUTCString()}`, "", body].join("\r\n");
    const run = (parser: string, raws: string[]) =>
      runEmailCodePipeline({ parsers: reg(), parserName: parser, args: { ...args("fan@example.com"), site: "other" }, transport: transport(raws), max: 3, newerThan: "disabled" });
    expect(await run("otp(from=axs.com;subject=code)", [mail("Your AXS code", "Your verification code is 4821.\r\nRef 99887766")])).toBe("#PARSE FAILED");
    expect(await run("otp(from=axs.com;subject=code;len=4)", [mail("Your AXS code", "Your verification code is 4821.")])).toBe("4821");
    expect(await run("otp(from=axs.com;subject=code)", [mail("Your AXS code", "code 112233", "Other <x@other.com>")])).toBe("#PARSE FAILED");
  });

  it("rejects unsafe or meaningless configs before any mailbox is touched", () => {
    expect(otpParser('otp(from=a.com" OR label:x)')).toMatch(/^#BAD PARSER otp from has characters/);
    expect(otpParser("otp(len=6)")).toMatch(/needs from= or subject=/);
    expect(otpParser("otp(color=red)")).toMatch(/unknown/);
    expect(otpParser("otp(subject=code;len=3)")).toMatch(/len must be 4–10/);
    expect(lookupParser(reg(), "nope")).toBe("#NO PARSER nope");
  });
});
