import { describe, expect, it } from "vitest";
import {
  CLAIMS,
  expectationClaims,
  type Claim,
} from "../verify/claims.js";
import type { PageProbe } from "../src/application/runtime/cdp/cdp-page.js";

/**
 * Claim logic tests: a scripted PageProbe answers expressions from a map, so
 * claim pass/fail logic is tested without a browser. The live engine run is
 * the manual spike gate; these tests keep the claim library honest in CI.
 */
function fakePage(answers: Record<string, unknown>): PageProbe {
  return {
    async evaluate(expression: string) {
      if (expression in answers) return answers[expression];
      throw new Error(`no scripted answer for: ${expression.slice(0, 60)}`);
    },
  };
}

function claim(id: string): Claim {
  const c = CLAIMS.find((c) => c.id === id);
  if (!c) throw new Error(`no claim ${id}`);
  return c;
}

describe("detection claims", () => {
  it("webdriver-hidden passes on false/undefined, fails on true", async () => {
    const c = claim("webdriver-hidden");
    expect((await c.check(fakePage({ "navigator.webdriver": false }))).pass).toBe(true);
    expect((await c.check(fakePage({ "navigator.webdriver": undefined }))).pass).toBe(true);
    expect((await c.check(fakePage({ "navigator.webdriver": true }))).pass).toBe(false);
  });

  it("ua-stock-shaped rejects HeadlessChrome and brand leaks", async () => {
    const c = claim("ua-stock-shaped");
    const stock = {
      "navigator.userAgent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36",
    };
    expect((await c.check(fakePage(stock))).pass).toBe(true);
    expect(
      (await c.check(fakePage({ "navigator.userAgent": "Mozilla/5.0 HeadlessChrome/157.0.0.0" }))).pass,
    ).toBe(false);
    expect(
      (await c.check(fakePage({ "navigator.userAgent": "Mozilla/5.0 Fury/157 Chrome/157.0.0.0" }))).pass,
    ).toBe(false);
  });

  it("permissions-consistent requires API and query to agree", async () => {
    const c = claim("permissions-consistent");
    const pagePass: PageProbe = {
      evaluate: async () => ({ api: "default", query: "default" }),
    };
    const pageFail: PageProbe = {
      evaluate: async () => ({ api: "denied", query: "prompt" }),
    };
    expect((await c.check(pagePass)).pass).toBe(true);
    expect((await c.check(pageFail)).pass).toBe(false);
  });

  it("canvas-deterministic fails when two draws differ", async () => {
    const c = claim("canvas-deterministic");
    const passPage: PageProbe = { evaluate: async () => true };
    const failPage: PageProbe = { evaluate: async () => false };
    expect((await c.check(passPage)).pass).toBe(true);
    expect((await c.check(failPage)).pass).toBe(false);
  });

  it("chrome-object asserts the stock surface (loadTimes/csi), not chrome.runtime", async () => {
    const c = claim("chrome-object");
    // Stock Chrome 156/157 measured: window.chrome = {loadTimes, csi[, app]};
    // chrome.runtime is NOT on web pages — the claim must not require it.
    const stockPage: PageProbe = { evaluate: async () => true };
    const patchedPage: PageProbe = { evaluate: async () => false };
    expect((await c.check(stockPage)).pass).toBe(true);
    expect((await c.check(patchedPage)).pass).toBe(false);
  });

  it("expectation claims skip absent expectations and compare present ones", async () => {
    const claims = expectationClaims({ platform: "Win32", screenWidth: 1920 });
    expect(claims.map((c) => c.id).sort()).toEqual(["persona-platform", "persona-screen"]);
    const page: PageProbe = {
      evaluate: async (expr) =>
        expr === "navigator.platform" ? "Win32" : expr === "screen.width" ? 1920 : null,
    };
    for (const c of claims) {
      expect((await c.check(page)).pass).toBe(true);
    }
    const bad: PageProbe = { evaluate: async () => "Linux x86_64" };
    const platformClaim = claims.find((c) => c.id === "persona-platform")!;
    expect((await platformClaim.check(bad)).pass).toBe(false);
  });
});
