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

  it("webrtc-no-host-candidates passes relay-only, fails host/srflx leaks", async () => {
    const c = claim("webrtc-no-host-candidates");
    const clean: PageProbe = { evaluate: async () => ({ types: ["typ relay"] }) };
    const empty: PageProbe = { evaluate: async () => ({ types: [] }) };
    const host: PageProbe = { evaluate: async () => ({ types: ["typ host", "typ srflx"] }) };
    expect((await c.check(clean)).pass).toBe(true);
    expect((await c.check(empty)).pass).toBe(true);
    expect((await c.check(host)).pass).toBe(false);
  });

  it("audio-deterministic requires two context hashes to match", async () => {
    const c = claim("audio-deterministic");
    const passPage: PageProbe = { evaluate: async () => ({ a: 42, b: 42, same: true }) };
    const failPage: PageProbe = { evaluate: async () => ({ a: 42, b: 43, same: false }) };
    expect((await c.check(passPage)).pass).toBe(true);
    expect((await c.check(failPage)).pass).toBe(false);
  });

  it("fonts-standard-families fails when any standard family is unresolved", async () => {
    const c = claim("fonts-standard-families");
    const passPage: PageProbe = {
      evaluate: async () => [
        { f: "12px Arial", ok: true },
        { f: "16px monospace", ok: true },
        { f: "14px \"Times New Roman\"", ok: true },
      ],
    };
    const failPage: PageProbe = {
      evaluate: async () => [
        { f: "12px Arial", ok: true },
        { f: "16px monospace", ok: false },
        { f: "14px \"Times New Roman\"", ok: true },
      ],
    };
    expect((await c.check(passPage)).pass).toBe(true);
    expect((await c.check(failPage)).pass).toBe(false);
  });

  it("webgpu-present-or-null accepts resolving-null, rejects missing api or rejection", async () => {
    const c = claim("webgpu-present-or-null");
    const noGpu: PageProbe = { evaluate: async () => ({ api: true, rejected: false, adapter: false }) };
    const withGpu: PageProbe = { evaluate: async () => ({ api: true, rejected: false, adapter: true }) };
    const missing: PageProbe = { evaluate: async () => ({ api: false, rejected: false, adapter: false }) };
    const rejected: PageProbe = { evaluate: async () => ({ api: true, rejected: true, adapter: false }) };
    expect((await c.check(noGpu)).pass).toBe(true);
    expect((await c.check(withGpu)).pass).toBe(true);
    expect((await c.check(missing)).pass).toBe(false);
    expect((await c.check(rejected)).pass).toBe(false);
  });

  it("battery-desktop-mains skips without getBattery, requires charging+level 1", async () => {
    const c = claim("battery-desktop-mains");
    const noApi: PageProbe = { evaluate: async () => ({ api: null }) };
    const desktop: PageProbe = {
      evaluate: async () => ({ api: true, charging: true, level: 1, dt: Infinity }),
    };
    const laptopLeak: PageProbe = {
      evaluate: async () => ({ api: true, charging: false, level: 0.62, dt: 7200 }),
    };
    const noApiResult = await c.check(noApi);
    expect(noApiResult.skipped).toBe(true);
    expect((await c.check(desktop)).pass).toBe(true);
    expect((await c.check(laptopLeak)).pass).toBe(false);
  });

  it("media-devices-sane requires at least one audio output", async () => {
    const c = claim("media-devices-sane");
    const sane: PageProbe = {
      evaluate: async () => ({ kinds: ["audiooutput", "audioinput"], out: 1 }),
    };
    const empty: PageProbe = { evaluate: async () => ({ kinds: [], out: 0 }) };
    expect((await c.check(sane)).pass).toBe(true);
    expect((await c.check(empty)).pass).toBe(false);
  });

  it("speech-voices-sane requires populated, stable, well-formed voices", async () => {
    const c = claim("speech-voices-sane");
    const good: PageProbe = {
      evaluate: async () => ({ api: true, count: 4, stable: true, malformed: 0 }),
    };
    const empty: PageProbe = {
      evaluate: async () => ({ api: true, count: 0, stable: true, malformed: 0 }),
    };
    const noisy: PageProbe = {
      evaluate: async () => ({ api: true, count: 4, stable: false, malformed: 0 }),
    };
    const malformed: PageProbe = {
      evaluate: async () => ({ api: true, count: 4, stable: true, malformed: 1 }),
    };
    const noApi: PageProbe = { evaluate: async () => ({ api: false, voices: null }) };
    expect((await c.check(good)).pass).toBe(true);
    expect((await c.check(empty)).pass).toBe(false);
    expect((await c.check(noisy)).pass).toBe(false);
    expect((await c.check(malformed)).pass).toBe(false);
    expect((await c.check(noApi)).pass).toBe(false);
  });

  it("client-rects-deterministic fails when either rect read is unstable", async () => {
    const c = claim("client-rects-deterministic");
    const stable: PageProbe = { evaluate: async () => ({ rectSame: true, clientSame: true }) };
    const noisy: PageProbe = { evaluate: async () => ({ rectSame: true, clientSame: false }) };
    expect((await c.check(stable)).pass).toBe(true);
    expect((await c.check(noisy)).pass).toBe(false);
  });

  it("performance-memory-present requires a positive heap limit", async () => {
    const c = claim("performance-memory-present");
    const chromePage: PageProbe = { evaluate: async () => ({ limit: 2_170_000_000 }) };
    const stripped: PageProbe = { evaluate: async () => null };
    const zeroPage: PageProbe = { evaluate: async () => ({ limit: 0 }) };
    expect((await c.check(chromePage)).pass).toBe(true);
    expect((await c.check(stripped)).pass).toBe(false);
    expect((await c.check(zeroPage)).pass).toBe(false);
  });
});
