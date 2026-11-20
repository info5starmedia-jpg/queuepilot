import { describe, expect, it } from "vitest";
import {
  localeForCountry,
  type LaunchProxyEndpoint,
  type ProxyExitGeo,
} from "../src/application/lifecycle/browser.lifecycle.service.js";
import { makeTestContext, type TestContext } from "./helpers.js";

/**
 * The browser's timezone and locale follow the proxy's exit IP.
 * Timezone: profile pin > the proxy's own timezone field > exit-IP lookup
 * through the proxy > identity default. Locale: profile pin > the exit
 * country's locale > identity. The lookup is faked here; production uses the
 * same geo echo as the proxy Test button, through the proxy itself.
 */

type Answer = string | ProxyExitGeo | null;

/** A bare string answer = timezone only (no country), as the lookup used to be. */
function withLookup(ctx: TestContext, answer: (p: LaunchProxyEndpoint) => Answer | Promise<Answer>) {
  const calls: LaunchProxyEndpoint[] = [];
  Reflect.set(ctx.lifecycle, "proxyGeoLookup", async (p: LaunchProxyEndpoint) => {
    calls.push(p);
    const a = await answer(p);
    return typeof a === "string" ? { timezone: a, countryCode: null } : a;
  });
  return calls;
}

async function proxiedProfile(ctx: TestContext) {
  const proxy = await ctx.proxies.create({
    name: "ashburn",
    type: "http",
    host: "203.0.113.30",
    port: 2124,
    username: "u",
    password: "pw",
  });
  const p = ctx.profiles.create({ name: "tz", generateFingerprint: true, proxyId: proxy.id });
  return { proxy, profileId: p.id };
}

/** Timezone the engine was actually launched with (fake runtime keeps it). */
const launchedTz = (ctx: TestContext) => ctx.runtime.sessions.at(-1)!["identity"]?.timezone;

describe("browser timezone follows the proxy", () => {
  it("uses the exit IP's timezone, records it, and leaves the stored identity alone", async () => {
    const ctx = makeTestContext();
    const calls = withLookup(ctx, () => "America/New_York");
    const { profileId } = await proxiedProfile(ctx);
    const before = ctx.profiles.get(profileId);

    await ctx.lifecycle.start(profileId);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ host: "203.0.113.30", port: 2124, username: "u", password: "pw" });
    expect(launchedTz(ctx)).toBe("America/New_York");
    const egress = ctx.lifecycle.egressDiagnostics(profileId)!;
    expect(egress.timezone).toBe("America/New_York");
    expect(egress.timezoneSource).toBe("exit-ip");
    // Per-launch only: the profile's identity of record is unchanged.
    const ident = (await ctx.app.inject({ method: "GET", url: `/profiles/${profileId}/identity` })).json().identity;
    expect(ident.timezone).not.toBe("America/New_York");
    // The launch must not persist a timezone pin (host-coherence screen pins
    // are a separate, intentional write and must never smuggle one in).
    expect(ident.overrides?.timezone ?? null).toBeNull();
    expect(before.identityId).toBe(ident.id);
  });

  it("a timezone pinned on the profile always wins over the lookup", async () => {
    const ctx = makeTestContext();
    const calls = withLookup(ctx, () => "America/New_York");
    const { profileId } = await proxiedProfile(ctx);
    await ctx.app.inject({ method: "PATCH", url: `/profiles/${profileId}/identity`, payload: { timezone: "Europe/Paris" } });

    await ctx.lifecycle.start(profileId);

    // The lookup still runs once — the locale (unpinned) needs the exit country.
    expect(calls).toHaveLength(1);
    expect(launchedTz(ctx)).toBe("Europe/Paris");
    expect(ctx.lifecycle.egressDiagnostics(profileId)!.timezoneSource).toBe("pinned");
  });

  it("the proxy's own timezone field beats the lookup", async () => {
    const ctx = makeTestContext();
    const calls = withLookup(ctx, () => "America/Toronto");
    const { proxy, profileId } = await proxiedProfile(ctx);
    // Provider files carry this as their 6th column.
    ctx.proxies["proxies"]["db"].prepare("UPDATE proxies SET timezone = ? WHERE id = ?").run("America/New_York", proxy.id);

    await ctx.lifecycle.start(profileId);

    expect(calls).toHaveLength(1); // for the locale only
    expect(launchedTz(ctx)).toBe("America/New_York");
    expect(ctx.lifecycle.egressDiagnostics(profileId)!.timezoneSource).toBe("proxy");
  });

  it("a failed, empty or nonsense lookup falls back to the identity default — never a failed launch", async () => {
    for (const answer of [() => null, () => "Mars/Olympus_Mons", () => Promise.reject(new Error("timeout"))]) {
      const ctx = makeTestContext();
      withLookup(ctx, answer as () => string | null);
      const { profileId } = await proxiedProfile(ctx);
      const identityTz = (await ctx.app.inject({ method: "GET", url: `/profiles/${profileId}/identity` })).json().identity.timezone;

      const run = await ctx.lifecycle.start(profileId);

      expect(run.status).toBe("running");
      expect(launchedTz(ctx)).toBe(identityTz);
      expect(ctx.lifecycle.egressDiagnostics(profileId)!.timezoneSource).toBe("identity");
    }
  });

  it("no proxy: the machine's own timezone, no lookup", async () => {
    const ctx = makeTestContext();
    const calls = withLookup(ctx, () => "America/New_York");
    const p = ctx.profiles.create({ name: "direct", generateFingerprint: true });
    Reflect.set(ctx.lifecycle, "hostTimezone", () => "America/Toronto");

    await ctx.lifecycle.start(p.id);

    expect(calls).toHaveLength(0);
    // The identity default (UTC) would contradict the direct connection's
    // real IP — the host zone is the coherent answer.
    expect(launchedTz(ctx)).toBe("America/Toronto");
    expect(ctx.lifecycle.egressDiagnostics(p.id)!.timezoneSource).toBe("host");
  });

  it("no proxy but no usable host timezone: falls back to the identity default", async () => {
    const ctx = makeTestContext();
    const p = ctx.profiles.create({ name: "direct-nozone", generateFingerprint: true });
    Reflect.set(ctx.lifecycle, "hostTimezone", () => null);

    await ctx.lifecycle.start(p.id);

    const identityTz = (await ctx.app.inject({ method: "GET", url: `/profiles/${p.id}/identity` })).json().identity.timezone;
    expect(launchedTz(ctx)).toBe(identityTz);
    expect(ctx.lifecycle.egressDiagnostics(p.id)!.timezoneSource).toBe("identity");
  });

  it("a temporary proxy is looked up through itself", async () => {
    const ctx = makeTestContext();
    const calls = withLookup(ctx, (p) => (p.host === "198.51.100.7" ? "Asia/Tokyo" : null));
    const p = ctx.profiles.create({ name: "temp", generateFingerprint: true });

    await ctx.lifecycle.start(p.id, { tempProxy: { type: "socks5", host: "198.51.100.7", port: 1080 } });

    expect(calls[0]).toMatchObject({ type: "socks5", host: "198.51.100.7", port: 1080 });
    expect(launchedTz(ctx)).toBe("Asia/Tokyo");
    expect(ctx.lifecycle.egressDiagnostics(p.id)!.timezoneSource).toBe("exit-ip");
  });
});

/** Locale the engine was actually launched with. */
const launchedLocale = (ctx: TestContext) => ctx.runtime.sessions.at(-1)!["identity"]?.locale;

describe("browser locale follows the proxy's exit country", () => {
  it("derives the locale from the exit country, records it, and leaves the stored identity alone", async () => {
    const ctx = makeTestContext();
    const calls = withLookup(ctx, () => ({ timezone: "Europe/Berlin", countryCode: "DE" }));
    const { profileId } = await proxiedProfile(ctx);

    await ctx.lifecycle.start(profileId);

    expect(calls).toHaveLength(1); // one lookup serves timezone AND locale
    expect(launchedTz(ctx)).toBe("Europe/Berlin");
    expect(launchedLocale(ctx)).toBe("de-DE");
    const diag = ctx.lifecycle.egressDiagnostics(profileId)!;
    expect(diag.locale).toBe("de-DE");
    expect(diag.localeSource).toBe("exit-ip");
    const ident = (await ctx.app.inject({ method: "GET", url: `/profiles/${profileId}/identity` })).json().identity;
    expect(ident.locale).not.toBe("de-DE");
  });

  it("a locale pinned on the profile always wins", async () => {
    const ctx = makeTestContext();
    withLookup(ctx, () => ({ timezone: "Europe/Berlin", countryCode: "DE" }));
    const { profileId } = await proxiedProfile(ctx);
    await ctx.app.inject({ method: "PATCH", url: `/profiles/${profileId}/identity`, payload: { locale: "en-GB" } });

    await ctx.lifecycle.start(profileId);

    expect(launchedLocale(ctx)).toBe("en-GB");
    expect(launchedTz(ctx)).toBe("Europe/Berlin"); // timezone still follows the exit
    expect(ctx.lifecycle.egressDiagnostics(profileId)!.localeSource).toBe("pinned");
  });

  it("both pinned: no lookup at all", async () => {
    const ctx = makeTestContext();
    const calls = withLookup(ctx, () => ({ timezone: "Europe/Berlin", countryCode: "DE" }));
    const { profileId } = await proxiedProfile(ctx);
    await ctx.app.inject({ method: "PATCH", url: `/profiles/${profileId}/identity`, payload: { locale: "en-GB", timezone: "Europe/London" } });

    await ctx.lifecycle.start(profileId);

    expect(calls).toHaveLength(0);
    expect(launchedLocale(ctx)).toBe("en-GB");
    expect(launchedTz(ctx)).toBe("Europe/London");
  });

  it("no country, an unknown country, or a failed lookup keeps the identity's locale — never a failed launch", async () => {
    for (const answer of [
      () => ({ timezone: "Europe/Berlin", countryCode: null }),
      () => ({ timezone: null, countryCode: "ZZZ" }),
      () => null,
      () => Promise.reject(new Error("timeout")),
    ]) {
      const ctx = makeTestContext();
      withLookup(ctx, answer as () => Answer);
      const { profileId } = await proxiedProfile(ctx);
      const identityLocale = (await ctx.app.inject({ method: "GET", url: `/profiles/${profileId}/identity` })).json().identity.locale;

      const run = await ctx.lifecycle.start(profileId);

      expect(run.status).toBe("running");
      expect(launchedLocale(ctx)).toBe(identityLocale);
      expect(ctx.lifecycle.egressDiagnostics(profileId)!.localeSource).toBe("identity");
    }
  });

  it("no proxy: the identity's locale is kept and no lookup is made", async () => {
    const ctx = makeTestContext();
    const calls = withLookup(ctx, () => ({ timezone: "Europe/Berlin", countryCode: "DE" }));
    const p = ctx.profiles.create({ name: "direct-locale", generateFingerprint: true });
    const identityLocale = (await ctx.app.inject({ method: "GET", url: `/profiles/${p.id}/identity` })).json().identity.locale;

    await ctx.lifecycle.start(p.id);

    expect(calls).toHaveLength(0);
    expect(launchedLocale(ctx)).toBe(identityLocale);
  });

  it("localeForCountry maps countries via CLDR likely-subtags and rejects junk", () => {
    expect(localeForCountry("DE")).toBe("de-DE");
    expect(localeForCountry("gb")).toBe("en-GB");
    expect(localeForCountry("CH")).toBe("de-CH");
    expect(localeForCountry("FR")).toBe("fr-FR");
    expect(localeForCountry(null)).toBeNull();
    expect(localeForCountry("")).toBeNull();
    expect(localeForCountry("DEU")).toBeNull();
    expect(localeForCountry("1A")).toBeNull();
  });
});
