import { describe, expect, it } from "vitest";
import { makeTestContext } from "./helpers.js";
import { ipApiCountry, localiseVisits } from "../src/application/warmups/persona-warmup.service.js";
import { DEFAULT_PERSONA, PersonaSchema, isPublicWebUrl } from "../src/application/warmups/persona/warmup/persona.js";
import { CONSENT_CLICKABLES, CONSENT_TEXT } from "../src/application/warmups/persona/driver/consent.js";
import { isAccountOrActionUrl, isFollowable } from "../src/application/warmups/persona/core/url.js";

/** Security-audit fixes on the warmer port (2026-11-19) and per-country sites. */
describe("persona warmup safety", () => {
  it("persona URLs must be public http(s) sites", () => {
    for (const ok of ["https://www.walmart.com", "http://example.org/x", "https://www.google.com/search?q={q}"]) {
      expect(isPublicWebUrl(ok)).toBe(true);
    }
    for (const bad of [
      "file:///C:/x",
      "javascript:alert(1)",
      "http://localhost:50325",
      "http://127.0.0.1:9222/json",
      "http://10.0.0.5",
      "http://192.168.1.1",
      "http://172.20.0.1",
      "http://169.254.169.254/latest",
      "http://[::1]/",
      "http://api.localhost",
      "http://intranet",
    ]) {
      expect(isPublicWebUrl(bad), bad).toBe(false);
    }
    expect(PersonaSchema.safeParse({ ...DEFAULT_PERSONA, sites: [{ ...DEFAULT_PERSONA.sites[0], url: "http://127.0.0.1:50325" }] }).success).toBe(false);
  });

  it("consent text never matches bare Continue / OK, and never targets links or form buttons", () => {
    for (const t of ["Accept all", "Accept Cookies", "I agree", "Got it", "Allow all"]) expect(CONSENT_TEXT.test(t), t).toBe(true);
    for (const t of ["Continue", "OK", "Okay", "Sign in", "Place order", "Cookie settings"]) expect(CONSENT_TEXT.test(t), t).toBe(false);
    expect(CONSENT_CLICKABLES).not.toMatch(/(^|,\s*)a(\s*,|$)/);
    expect(CONSENT_CLICKABLES).toContain(":not(form button)");
  });

  it("account, cart, checkout and action URLs are never followed", () => {
    for (const u of [
      "https://www.amazon.com/ap/signin",
      "https://www.bestbuy.com/cart",
      "https://www.walmart.com/account/orders",
      "https://shop.example/checkout/step-1",
      "https://shop.example/signout",
      "https://shop.example/p/123?action=add",
      "https://shop.example/buy-now/123",
    ]) {
      expect(isAccountOrActionUrl(u), u).toBe(true);
      expect(isFollowable(u), u).toBe(false);
    }
    expect(isFollowable("https://www.bestbuy.com/site/tvs/abcat0101000.c")).toBe(true);
  });

  it("localises visits to the exit-IP country and drops the foreign store search", () => {
    const bestbuy = DEFAULT_PERSONA.sites.find((s) => s.url.includes("bestbuy"))!;
    const sessions = [
      { visits: [{ url: bestbuy.url, productSearchUrl: `${bestbuy.url}/site/searchpage.jsp?st=tv` }, { url: "https://www.reddit.com" }] },
    ] as unknown as Parameters<typeof localiseVisits>[0];
    localiseVisits(sessions, DEFAULT_PERSONA, "ca");
    const [a, b] = sessions[0]!.visits as unknown as { url: string; productSearchUrl?: string }[];
    expect(a!.url).toBe("https://www.bestbuy.ca");
    expect(a!.productSearchUrl).toBeUndefined();
    expect(b!.url).toBe("https://www.reddit.com");
  });

  it("ipApiCountry returns the ISO-2 code, null on bad input or failure", async () => {
    const ok = (async () => ({ json: async () => ({ countryCode: "CA" }) })) as unknown as typeof fetch;
    expect(await ipApiCountry("203.0.113.7", ok)).toBe("CA");
    expect(await ipApiCountry("not an ip/../x", ok)).toBeNull();
    const boom = (async () => { throw new Error("down"); }) as unknown as typeof fetch;
    expect(await ipApiCountry(null, boom)).toBeNull();
    const junk = (async () => ({ json: async () => ({ countryCode: "<b>" }) })) as unknown as typeof fetch;
    expect(await ipApiCountry(null, junk)).toBeNull();
  });

  it("warmer routes refuse requests from a page inside a profile browser", async () => {
    const ctx = makeTestContext();
    for (const url of ["/warmups/personas", "/profiles/x/warmup/persona", "/profiles/x/resolve", "/integrations/aycd"]) {
      const r = await ctx.app.inject({ method: "GET", url, headers: { "sec-fetch-site": "cross-site" } });
      expect(r.statusCode, url).toBe(403);
      const o = await ctx.app.inject({ method: "GET", url, headers: { origin: "https://evil.example" } });
      expect(o.statusCode, url).toBe(403);
    }
    expect((await ctx.app.inject({ method: "GET", url: "/warmups/personas" })).statusCode).toBe(200);
  });
});
