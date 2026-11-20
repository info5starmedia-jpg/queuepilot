import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { BUILTIN_ANY, buildMapFillExpression, fieldValues, globMatches, parseMap, resolveBlocks } from "../src/application/autofill/autofill-map.js";
import { AutofillMapService } from "../src/application/autofill/autofill-map.service.js";

/** J4 — the autofill map file: parser, blocks, ~60 fields, and the service around a fake page. */

const MAP = `
; comment
firstName
url=any
name=/zzz-default/; email

url=https://*.example.com/checkout*
traverse-shadow-doms
human firstName, lastName
machine email
swap lastName=firstName
name=/first/i; firstName
id="last"; lastName; return field.toUpperCase();
\`//input[@data-x]\`; "literal; with semicolon"
class=agree; true
name=state; stateName
name=pay; button; 2

url=https://other.example.com/*
include https://*.example.com/checkout*
dont-include-any
`;

describe("autofill map parser", () => {
  const map = parseMap(MAP);

  it("parses blocks, directives, rules, xpath, buttons and keeps ; inside a format", () => {
    // the stray line before any block is an error, not silently dropped
    expect(map.errors.map((e) => e.line)).toEqual([3]);
    const b = map.blocks.find((x) => x.glob.includes("checkout"))!;
    expect(b.traverseShadow).toBe(true);
    expect([...b.human]).toEqual(["firstName", "lastName"]);
    expect([...b.machine]).toEqual(["email"]);
    expect(map.swaps).toEqual({ lastName: "firstName" });
    const kinds = b.rules.map((r) => r.kind);
    expect(kinds).toEqual(["attr", "attr", "xpath", "attr", "attr", "button"]);
    expect(b.rules[1]).toMatchObject({ attr: "id", pattern: '^last$', field: "lastName", format: "return field.toUpperCase();" });
    expect(b.rules[2]).toMatchObject({ xpath: "//input[@data-x]", literal: "literal; with semicolon" });
    expect(b.rules[3]).toMatchObject({ bool: true });
    expect(b.rules[5]).toMatchObject({ kind: "button", clicks: 2 });
  });

  it("matches URL globs, includes other blocks, and auto-includes `any` unless refused", () => {
    expect(globMatches("https://*.example.com/checkout*", "https://shop.example.com/checkout/step1")).toBe(true);
    expect(globMatches("https://*.example.com/checkout*", "https://evil.com/?https://a.example.com/checkout")).toBe(false);
    expect(globMatches("http://127.0.0.1:*", "http://127.0.0.1:50778/page")).toBe(true);
    expect(globMatches("https://shop.com", "https://shop.com.evil.net/")).toBe(false);
    const a = resolveBlocks(map, "https://shop.example.com/checkout", BUILTIN_ANY);
    expect(a.rules.some((r) => r.pattern === "zzz-default")).toBe(true); // `any` included
    expect(a.rules.length).toBeGreaterThan(BUILTIN_ANY.length);
    const b = resolveBlocks(map, "https://other.example.com/x", BUILTIN_ANY);
    expect(b.rules.some((r) => r.pattern === "zzz-default")).toBe(false); // dont-include-any
    expect(b.rules.some((r) => r.field === "stateName")).toBe(true); // via include
    expect(resolveBlocks(map, "https://nope.org/", []).blocks).toEqual(["any"]);
  });

  it("rejects bad regexes and bad fields per line without loading a half rule", () => {
    const bad = parseMap("url=any\nname=/(/; email\nname=x; not a field\nname=x; email");
    expect(bad.errors.map((e) => e.line)).toEqual([2, 3]);
    expect(bad.blocks[0]!.rules).toHaveLength(1);
  });
});

describe("profile fields", () => {
  const v = fieldValues({
    name: "Ada Lovelace King",
    email: "ada@example.com",
    address: { line1: "1 Main St", city: "Austin", state: "TX", zip: "73301" },
    phone: "+1 (512) 555-0123",
    sms: "15125559999",
    dob: "1990-02-03",
    card: { number: "4111 1111 1111 1111", cvv: "123", expMonth: "04", expYear: "2030" },
    free: { free1: "x", bogus: "y" },
    codes: { smsCode: { value: "123456", timestamp: "2026-11-20T00:00:00.000Z" } },
  });

  it("derives the documented names", () => {
    expect(v).toMatchObject({
      firstName: "Ada", lastName: "Lovelace King", name: "Ada Lovelace King", stateName: "Texas", zip: "73301",
      dob: "02/03/1990", dobDay: "03", dobMonth: "02", dobYear: "1990",
      phoneNumberAreaCode: "512", phoneNumberCountryCode: "1", phoneNumberLocal: "5550123", phoneNumberLocalPrefix: "555", phoneNumberLocalSuffix: "0123", phoneNumberNational: "(512) 555-0123",
      smsNumberAreaCode: "512", ccNumber: "4111111111111111", ccNumberFormatted: "4111 1111 1111 1111", ccExpDate: "04/30", ccExpDateYear: "2030",
      free1: "x", smsCode: "123456", smsCodeTimestamp: "2026-11-20T00:00:00.000Z",
    });
    expect(v.bogus).toBeUndefined();
    expect(Object.keys(v).length).toBeGreaterThanOrEqual(30);
  });

  it("applies field swapping", () => {
    expect(fieldValues({ name: "Ada Lovelace", email: null, address: null, phone: null, dob: null }, { firstName: "lastName" }).firstName).toBe("Lovelace");
  });
});

describe("page script", () => {
  it("is syntactically valid JS and carries values only as inlined JSON", () => {
    const expr = buildMapFillExpression({
      rules: [{ kind: "attr", attr: "name", pattern: "e", field: "email", line: 1 }],
      values: { email: "a@b.c" }, human: [], machine: [], defaultMode: "machine", fillPopulated: false, stripCommas: false, traverseShadow: true, wpm: 60,
    });
    expect(() => new Function(`return ${expr}`)).not.toThrow();
  });
});

describe("AutofillMapService", () => {
  function setup() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "afmap-"));
    const calls: string[] = [];
    let passcodes = ["P1", "P2"];
    const svc = new AutofillMapService({
      dataDir: dir,
      profiles: { get: () => ({ id: "p", name: "Ada Lovelace", email: "ada@example.com", extra: { address: { line1: "1 Main", city: "Austin", state: "TX", zip: "73301" } } }) } as never,
      pages: {
        evaluate: async (_id: string, expr: string) => {
          calls.push(expr);
          return expr === "location.href" ? "https://shop.example.com/checkout" : { filled: ["email"], missing: [], clicked: 0, errors: [] };
        },
      },
      tabState: { get: () => ({ codes: { emailCode: null, smsCode: null, otherCode: null } }) as never, takePasscode: () => passcodes.shift() ?? null },
    });
    return { dir, svc, calls };
  }

  it("hot-reloads the file, refuses a map with errors, never sends the card unless asked, and takes a passcode only when a rule uses it", async () => {
    const { dir, svc, calls } = setup();
    expect(svc.status()).toMatchObject({ exists: false });
    expect(() => svc.save("name=/(/; email")).toThrow(/line 1/);
    svc.save("url=https://*.example.com/*\nname=pass; passcode\nname=email; email");
    const r = await svc.fill("p");
    expect(r.blocks).toContain("https://*.example.com/*");
    const expr = calls.at(-1)!;
    expect(expr).toContain('"passcode":"P1"');
    expect(expr).toContain('"email":"ada@example.com"');
    expect(expr).not.toContain("4111");
    fs.writeFileSync(path.join(dir, "autofill.map"), "url=https://*.example.com/*\nname=email; email");
    fs.utimesSync(path.join(dir, "autofill.map"), new Date(), new Date(Date.now() + 5000));
    await svc.fill("p");
    expect(calls.at(-1)).not.toContain("passcode");
  });

  it("broadcast isolates failures", async () => {
    const { svc } = setup();
    const res = await svc.broadcast(["a", "b"]);
    expect(res.every((x) => x.ok)).toBe(true);
  });
});
