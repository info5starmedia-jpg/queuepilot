import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ParserRegistry } from "../src/application/parsers/parser-registry.js";
import { registerBuiltinParsers } from "../src/application/parsers/builtin-parsers.js";
import { loadJylParsers } from "../src/application/parsers/jyl-parser-loader.js";
import { ResolverRegistry, registerBuiltinResolvers } from "../src/application/resolvers/resolver-registry.js";
import { registerImapResolver } from "../src/application/resolvers/imap-resolver.js";
import type { ImapClientLike } from "../src/application/email/imap-flow-transport.js";

/**
 * J1 slice C2 — Jancy `.jyl` parser files load as-is. Fixtures are the two
 * examples Jancy publishes in its own docs (docs.jancy.io/docs/jyl/
 * email-parser-tag and /sms-parser-tag), unmodified apart from whitespace.
 */

const DOCS_EMAIL_PARSER = `<jyl>
  <email-parser name="smsdeliverer-ticketmaster">
    <description>
      Looks for emails from the SMSDeliverer softwawre that contains SMS text messages from Ticketmaster containing a 2FA authentication code.
    </description>
    <example>
      Sender: 77598
      Receiver: 12223334444
      Timestamp: 2/4/2023 5:49:02 PM
      411733 is your Ticketmaster code.
    </example>
    <can-run>
      return args.profile?.smsNumber && args.site === 'ticketmaster'
    </can-run>
    <get-query>
      if (args.resolverName === 'gmail') {
        return \`(+(Receiver:) +(1\${ args.profile.smsNumber }) +(is your Ticketmaster code))\`
      }
      // args.resolverName == 'imap'
      return {
        body: \`"Receiver:" "is your Ticketmaster code" "1\${ args.profile.smsNumber }"\`
      }
    </get-query>
    <parse-message>
      const match = msg.text.match(/(\\d+) is your Ticketmaster code/)
      if (match) {
        return match[1]
      }
      jancy.console.log(\`smsdeliverer-ticketmaster-parser: failed parsing auth code from smsdeliverer email\`)
      return null
    </parse-message>
  </email-parser>
</jyl>`;

const DOCS_SMS_PARSER = `<jyl>
  <sms-parser name="google">
    <description>
      Parses codes from SMS messages sent by Google.
    </description>
    <example>
      G-928862 is your Google verification code.
    </example>
    <parse-message>
      let match = msg.match(/g-(\\d+) is your google verification code./i)
      return match ? match[1] : null
    </parse-message>
  </sms-parser>
</jyl>`;

function dirWith(files: Record<string, string>): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "qp-jyl-"));
  for (const [n, c] of Object.entries(files)) fs.writeFileSync(path.join(d, n), c);
  return d;
}

describe(".jyl parser import (Jancy's published format)", () => {
  it("loads the docs' email + sms parsers as user-<name>, with description/example", async () => {
    const reg = new ParserRegistry(dirWith({ "smsdeliverer.jyl": DOCS_EMAIL_PARSER, "google.jyl": DOCS_SMS_PARSER }));
    registerBuiltinParsers(reg);
    const scan = await reg.rescan();
    expect(scan).toEqual({ loaded: 2, errors: [] });
    const list = reg.list();
    expect(list.find((p) => p.name === "user-smsdeliverer-ticketmaster")).toMatchObject({
      kind: "email-parser", source: "user", file: "smsdeliverer.jyl",
    });
    expect(list.find((p) => p.name === "user-smsdeliverer-ticketmaster")!.example).toContain("411733 is your Ticketmaster code.");
    expect(reg.run("user-google", { subject: "", from: "", body: "G-928862 is your Google verification code." })).toEqual({
      ok: true, code: "928862",
    });
    expect(reg.get("ticketmaster")).not.toBeNull(); // builtins untouched
  });

  it("refuses tags that need Jancy's window/tab objects, keeps the parsers", () => {
    const src = `<jyl><command id="x" description="x">tw.closeTab()</command>
      <macro id="m">foo</macro>
      <sms-parser name="ok"><parse-message>return msg.slice(0, 4)</parse-message></sms-parser></jyl>`;
    const r = loadJylParsers(src, "mixed.jyl");
    expect(r.parsers.map((p) => p.name)).toEqual(["user-ok"]);
    expect(r.errors).toEqual([
      "mixed.jyl: <command> is not supported (it needs Jancy's tab/window objects) — skipped",
      "mixed.jyl: <macro> is not supported (it needs Jancy's tab/window objects) — skipped",
    ]);
  });

  it("reports broken files without taking the others down", () => {
    expect(loadJylParsers("hello", "x.jyl").errors[0]).toMatch(/not a .jyl file/);
    const r = loadJylParsers(`<jyl><email-parser name="half"><parse-message>return 1</parse-message></email-parser></jyl>`, "h.jyl");
    expect(r.errors[0]).toMatch(/needs <can-run> and <get-query>/);
    const bad = loadJylParsers(`<jyl><sms-parser name="syntax"><parse-message>return (</parse-message></sms-parser></jyl>`, "s.jyl");
    expect(bad.errors[0]).toMatch(/user-syntax parse-message/);
  });

  it("runs end to end: imap Jancy form + the docs' email parser + an ImapFlow body search", async () => {
    const reg = new ParserRegistry(dirWith({ "smsdeliverer.jyl": DOCS_EMAIL_PARSER }));
    await reg.rescan();
    const searches: unknown[] = [];
    const mail = [
      "From: SMS Deliverer <sms@relay.example>", "To: inbox@example.com", "Subject: SMS",
      `Date: ${new Date().toUTCString()}`, "", "Sender: 77598", "Receiver: 12223334444",
      "Timestamp: 2/4/2023 5:49:02 PM", "411733 is your Ticketmaster code.",
    ].join("\r\n");
    const factory = (): ImapClientLike => ({
      async connect() {},
      async getMailboxLock() { return { release() {} }; },
      async search(q) { searches.push(q); return [1]; },
      async fetchOne() { return { source: Buffer.from(mail), internalDate: new Date() }; },
      async logout() {},
    });
    const resolvers = new ResolverRegistry();
    registerBuiltinResolvers(resolvers);
    registerImapResolver(resolvers, { parsers: reg, imapClientFactory: factory });
    const v = await resolvers.resolve(
      "imap:127.0.0.1:1143:inbox@example.com:pw:user-smsdeliverer-ticketmaster",
      { siteKind: "ticketmaster", field: "smscode", profile: { smsNumber: "2223334444" } },
    );
    expect(v).toBe("411733");
    expect(searches[0]).toEqual({ body: '"Receiver:" "is your Ticketmaster code" "12223334444"' });
  });
});
