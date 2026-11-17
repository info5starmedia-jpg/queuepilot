import { describe, expect, it } from "vitest";
import type { LaunchProxyEndpoint } from "../src/application/lifecycle/browser.lifecycle.service.js";
import { makeTestContext, type TestContext } from "./helpers.js";

/**
 * The browser's timezone follows the proxy's exit IP. Precedence:
 * profile pin > the proxy's own timezone field > exit-IP lookup through the
 * proxy > identity default. The lookup is faked here; production uses the
 * same geo echo as the proxy Test button, through the proxy itself.
 */

function withLookup(ctx: TestContext, answer: (p: LaunchProxyEndpoint) => string | null | Promise<string | null>) {
  const calls: LaunchProxyEndpoint[] = [];
  Reflect.set(ctx.lifecycle, "proxyTimezoneLookup", async (p: LaunchProxyEndpoint) => {
    calls.push(p);
    return answer(p);
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
    expect(ident.overrides ?? null).toBeNull();
    expect(before.identityId).toBe(ident.id);
  });

  it("a timezone pinned on the profile always wins, and no lookup is made", async () => {
    const ctx = makeTestContext();
    const calls = withLookup(ctx, () => "America/New_York");
    const { profileId } = await proxiedProfile(ctx);
    await ctx.app.inject({ method: "PATCH", url: `/profiles/${profileId}/identity`, payload: { timezone: "Europe/Paris" } });

    await ctx.lifecycle.start(profileId);

    expect(calls).toHaveLength(0);
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

    expect(calls).toHaveLength(0);
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

  it("no proxy: no lookup, identity timezone", async () => {
    const ctx = makeTestContext();
    const calls = withLookup(ctx, () => "America/New_York");
    const p = ctx.profiles.create({ name: "direct", generateFingerprint: true });

    await ctx.lifecycle.start(p.id);

    expect(calls).toHaveLength(0);
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
