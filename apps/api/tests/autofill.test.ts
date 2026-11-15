import { describe, expect, it } from "vitest";
import {
  buildCardFillExpression,
  parseCardFillResult,
} from "../src/application/autofill/card-autofill.js";
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
