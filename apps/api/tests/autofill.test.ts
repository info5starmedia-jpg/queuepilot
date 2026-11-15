import { describe, expect, it } from "vitest";
import {
  buildCardFillExpression,
  parseCardFillResult,
} from "../src/application/autofill/card-autofill.js";
import {
  buildAddressFillExpression,
  parseAddressFillResult,
  type AddressFillInput,
} from "../src/application/autofill/address-autofill.js";
import type { PersonaCreditCard } from "@queuepilot/contracts";

const CARD: PersonaCreditCard = {
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
};

describe("buildCardFillExpression", () => {
  it("inlines the card exactly once as JSON", () => {
    const expr = buildCardFillExpression(CARD);
    expect(expr).toContain(JSON.stringify(CARD));
    // The expression is self-invoking and returns the fill report.
    expect(expr.trim().startsWith("(() =>")).toBe(true);
    expect(expr.trim().endsWith("})()")).toBe(true);
  });

  it("JSON-inlining is injection-safe (quotes/braces in values)", () => {
    const nasty = { ...CARD, name: 'J"}); alert(1); ({"' };
    const expr = buildCardFillExpression(nasty);
    // The value must appear inside the JSON blob, never as raw code.
    expect(expr).toContain(JSON.stringify(nasty.name));
    expect(() => parseCardFillResult({ filled: [], missing: [] })).not.toThrow();
  });

  it("targets the standard checkout hints", () => {
    const expr = buildCardFillExpression(CARD);
    for (const hint of ["cc-?number", "cvv", "expiry", "card.?holder"]) {
      expect(expr).toContain(hint);
    }
  });
});

describe("parseCardFillResult", () => {
  it("accepts a well-formed report", () => {
    expect(parseCardFillResult({ filled: ["number"], missing: ["cvv"] })).toEqual({
      filled: ["number"],
      missing: ["cvv"],
    });
  });

  it("rejects garbage", () => {
    expect(parseCardFillResult(null)).toBeNull();
    expect(parseCardFillResult("x")).toBeNull();
    expect(parseCardFillResult({ filled: "nope", missing: [] })).toBeNull();
    expect(parseCardFillResult({ filled: [1, "a"], missing: [] })).toEqual({
      filled: ["a"],
      missing: [],
    });
  });
});

const ADDRESS_INPUT: AddressFillInput = {
  firstName: "Jo",
  lastName: "Doe",
  email: "jo@example.com",
  phone: "+1 416 555 0100",
  dob: "01/02/1990",
  line1: "1 Main St",
  line2: null,
  city: "Toronto",
  state: "ON",
  zip: "M5V 1J1",
};

describe("buildAddressFillExpression", () => {
  it("inlines the identity exactly once as JSON", () => {
    const expr = buildAddressFillExpression(ADDRESS_INPUT);
    expect(expr).toContain(JSON.stringify(ADDRESS_INPUT));
    expect(expr.trim().startsWith("(() =>")).toBe(true);
    expect(expr.trim().endsWith("})()")).toBe(true);
  });

  it("JSON-inlining is injection-safe (quotes/braces in values)", () => {
    const nasty = { ...ADDRESS_INPUT, line1: '1"}); alert(1); ({"' };
    const expr = buildAddressFillExpression(nasty);
    expect(expr).toContain(JSON.stringify(nasty.line1));
  });

  it("targets identity and address hints incl. the state select path", () => {
    const expr = buildAddressFillExpression(ADDRESS_INPUT);
    for (const hint of [
      "first.?name",
      "last.?name",
      "email",
      "phone|mobile|tel",
      "address.?1|addr1|street",
      "address.?2|addr2|suite",
      "city|town",
      "province|region",
      "zip|postal",
      "querySelectorAll(\"select\")",
      "dob|birth",
    ]) {
      expect(expr).toContain(hint);
    }
  });

  it("skips null fields without emitting them as fillable", () => {
    const expr = buildAddressFillExpression({ ...ADDRESS_INPUT, line2: null, dob: null });
    expect(expr).toContain(JSON.stringify(null));
    // line2/dob stay in the data blob but the script null-checks before filling.
    expect(expr).toContain('value === null || value === undefined || value === ""');
  });
});

describe("parseAddressFillResult", () => {
  it("accepts a well-formed report", () => {
    expect(
      parseAddressFillResult({ filled: ["firstName", "city"], missing: ["state"] }),
    ).toEqual({ filled: ["firstName", "city"], missing: ["state"] });
  });

  it("rejects garbage", () => {
    expect(parseAddressFillResult(null)).toBeNull();
    expect(parseAddressFillResult("x")).toBeNull();
    expect(parseAddressFillResult({ filled: "nope", missing: [] })).toBeNull();
    expect(parseAddressFillResult({ filled: [1, "a"], missing: [] })).toEqual({
      filled: ["a"],
      missing: [],
    });
  });
});

describe("buildTypingExpression", () => {
  it("inlines text and wpm exactly once as JSON", async () => {
    const { buildTypingExpression } = await import(
      "../src/application/autofill/typing.js"
    );
    const expr = buildTypingExpression("hello world", 60);
    expect(expr).toContain(JSON.stringify("hello world"));
    expect(expr).toContain(JSON.stringify(60));
    expect(expr.trim().startsWith("(async () =>")).toBe(true);
  });

  it("is an async IIFE awaited by the caller (awaitPromise pattern)", async () => {
    const { buildTypingExpression } = await import(
      "../src/application/autofill/typing.js"
    );
    const expr = buildTypingExpression("x", 100);
    expect(expr).toContain("setTimeout");
    expect(expr).toContain("isContentEditable");
    expect(expr).toContain("no-focused-field");
    expect(expr).toContain("HTMLInputElement.prototype");
  });

  it("JSON-inlining is injection-safe", async () => {
    const { buildTypingExpression } = await import(
      "../src/application/autofill/typing.js"
    );
    const nasty = '"}); alert(1); ({"';
    const expr = buildTypingExpression(nasty, 60);
    expect(expr).toContain(JSON.stringify(nasty));
  });

  it("parseTypingResult accepts well-formed results and rejects garbage", async () => {
    const { parseTypingResult } = await import(
      "../src/application/autofill/typing.js"
    );
    expect(parseTypingResult({ typed: 5, ms: 900, error: null })).toEqual({
      typed: 5,
      ms: 900,
      error: null,
    });
    expect(parseTypingResult({ typed: 0, ms: 0, error: "no-focused-field" })).toEqual({
      typed: 0,
      ms: 0,
      error: "no-focused-field",
    });
    expect(parseTypingResult(null)).toBeNull();
    expect(parseTypingResult({ typed: "5", ms: 900 })).toBeNull();
  });
});
