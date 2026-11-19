import { describe, expect, it } from "vitest";
import type { ProxyProbe } from "@queuepilot/contracts";
import type { LaunchProxyEndpoint, ProxyExitGeo } from "../src/application/lifecycle/browser.lifecycle.service.js";
import { isFreshProbe, PROBE_FRESH_MS, type BackgroundProbeOptions } from "../src/application/proxies/proxy.service.js";
import type { ProbeResult } from "../src/application/proxies/proxy-probe.js";
import { makeTestContext, type TestContext } from "./helpers.js";

/**
 * Proxy auto-test + stored geo. Every save probes in the background and the
 * result lands on the proxy as `lastProbe`; a launch reuses a fresh (<24 h)
 * successful probe instead of the live exit lookup (up to 8 s). Pins and the
 * proxy's own timezone field keep their precedence — the cache sits exactly
 * where the live lookup sits.
 */

const DE: ProbeResult = {
  ok: true,
  error: null,
  exitIp: "203.0.113.77",
  geo: { country: "Germany", countryCode: "DE", region: "Berlin", city: "Berlin", timezone: "Europe/Berlin" },
};

function probeAt(testedAt: Date, over: Partial<ProxyProbe> = {}): ProxyProbe {
  return {
    ok: true,
    error: null,
    exitIp: "203.0.113.77",
    country: "Germany",
    countryCode: "DE",
    region: "Berlin",
    city: "Berlin",
    timezone: "Europe/Berlin",
    latencyMs: 210,
    testedAt: testedAt.toISOString(),
    ...over,
  };
}

/** Fake live lookup that counts calls and answers Japan with a full probe. */
function withLookup(ctx: TestContext) {
  const calls: LaunchProxyEndpoint[] = [];
  Reflect.set(ctx.lifecycle, "proxyGeoLookup", async (p: LaunchProxyEndpoint): Promise<ProxyExitGeo> => {
    calls.push(p);
    return {
      timezone: "Asia/Tokyo",
      countryCode: "JP",
      probe: probeAt(new Date(), { country: "Japan", countryCode: "JP", city: "Tokyo", region: "Tokyo", timezone: "Asia/Tokyo" }),
    };
  });
  return calls;
}

/** Turn on background probing with a fake probe; returns the probe's call log. */
function withBackground(ctx: TestContext, result: ProbeResult = DE) {
  const calls: string[] = [];
  const opts: BackgroundProbeOptions = {
    probe: async (endpoint) => {
      calls.push(`${endpoint.host}:${endpoint.port}`);
      return result;
    },
  };
  Reflect.set(ctx.proxies, "background", opts);
  return calls;
}

async function proxiedProfile(ctx: TestContext) {
  const proxy = ctx.proxies.create({ name: "de", type: "http", host: "203.0.113.30", port: 2124, username: "u", password: "pw" });
  const p = ctx.profiles.create({ name: "geo", generateFingerprint: true, proxyId: proxy.id });
  return { proxy, profileId: p.id };
}

const launched = (ctx: TestContext) => ctx.runtime.sessions.at(-1)!["identity"] as { timezone: string; locale: string };

describe("launch reuses the stored probe", () => {
  it("cache hit: a fresh probe answers timezone AND locale — the live lookup is NOT called", async () => {
    const ctx = makeTestContext();
    const calls = withLookup(ctx);
    const { proxy, profileId } = await proxiedProfile(ctx);
    ctx.proxies.recordProbe(proxy.id, probeAt(new Date(Date.now() - 60_000)));

    await ctx.lifecycle.start(profileId);

    expect(calls).toHaveLength(0);
    expect(launched(ctx).timezone).toBe("Europe/Berlin");
    expect(launched(ctx).locale).toBe("de-DE");
    const diag = ctx.lifecycle.egressDiagnostics(profileId)!;
    expect(diag.timezoneSource).toBe("exit-ip");
    expect(diag.localeSource).toBe("exit-ip");
  });

  it("stale cache (>24 h): falls through to the live lookup and stores what it learns", async () => {
    const ctx = makeTestContext();
    const calls = withLookup(ctx);
    const { proxy, profileId } = await proxiedProfile(ctx);
    ctx.proxies.recordProbe(proxy.id, probeAt(new Date(Date.now() - PROBE_FRESH_MS - 60_000)));

    await ctx.lifecycle.start(profileId);

    expect(calls).toHaveLength(1);
    expect(launched(ctx).timezone).toBe("Asia/Tokyo");
    const stored = ctx.proxies.get(proxy.id).lastProbe!;
    expect(stored.countryCode).toBe("JP");
    expect(isFreshProbe(stored)).toBe(true);
  });

  it("cache miss (never tested) and a failed last probe both use the live lookup", async () => {
    for (const seed of [null, probeAt(new Date(), { ok: false, error: "connect timeout", timezone: null, countryCode: null })]) {
      const ctx = makeTestContext();
      const calls = withLookup(ctx);
      const { proxy, profileId } = await proxiedProfile(ctx);
      if (seed) ctx.proxies.recordProbe(proxy.id, seed);

      await ctx.lifecycle.start(profileId);

      expect(calls).toHaveLength(1);
      expect(launched(ctx).timezone).toBe("Asia/Tokyo");
    }
  });

  it("pins keep their precedence over the cache", async () => {
    const ctx = makeTestContext();
    const calls = withLookup(ctx);
    const { proxy, profileId } = await proxiedProfile(ctx);
    ctx.proxies.recordProbe(proxy.id, probeAt(new Date()));
    await ctx.app.inject({ method: "PATCH", url: `/profiles/${profileId}/identity`, payload: { timezone: "Europe/Paris", locale: "en-GB" } });

    await ctx.lifecycle.start(profileId);

    expect(calls).toHaveLength(0);
    expect(launched(ctx).timezone).toBe("Europe/Paris");
    expect(launched(ctx).locale).toBe("en-GB");
  });
});

describe("save-time auto-test", () => {
  it("create probes in the background and stores lastProbe with latencyMs and testedAt", async () => {
    const ctx = makeTestContext();
    const calls = withBackground(ctx);

    const res = await ctx.app.inject({
      method: "POST",
      url: "/proxies",
      payload: { name: "bg", type: "http", host: "203.0.113.40", port: 3128 },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().lastProbe).toBeNull(); // the save did not wait for the probe
    await ctx.proxies.whenProbesIdle();

    expect(calls).toEqual(["203.0.113.40:3128"]);
    const probe = (await ctx.app.inject({ method: "GET", url: `/proxies/${res.json().id}` })).json().lastProbe;
    expect(probe).toMatchObject({ ok: true, countryCode: "DE", city: "Berlin", timezone: "Europe/Berlin", exitIp: "203.0.113.77" });
    expect(typeof probe.latencyMs).toBe("number");
    expect(Number.isNaN(Date.parse(probe.testedAt))).toBe(false);
    // The health history gets the same probe.
    const history = (await ctx.app.inject({ method: "GET", url: `/proxies/${res.json().id}/health` })).json().history;
    expect(history).toHaveLength(1);
  });

  it("a failed auto-test is stored with its error and logged without credentials", async () => {
    const ctx = makeTestContext();
    const lines: string[] = [];
    Reflect.set(ctx.proxies, "background", {
      probe: async () => ({ ok: false, error: "proxy authentication failed (407)", exitIp: null, geo: null }),
      log: (l: string) => lines.push(l),
    } satisfies BackgroundProbeOptions);

    const p = ctx.proxies.create({ name: "bad", type: "http", host: "203.0.113.41", port: 1, username: "user1", password: "s3cret-pw" });
    await ctx.proxies.whenProbesIdle();

    expect(ctx.proxies.get(p.id).lastProbe).toMatchObject({ ok: false, error: "proxy authentication failed (407)", latencyMs: null });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("s3cret-pw");
  });

  it("an endpoint edit clears and re-probes; a name or group edit keeps the stored probe", async () => {
    const ctx = makeTestContext();
    const calls = withBackground(ctx);
    const p = ctx.proxies.create({ name: "e", type: "http", host: "203.0.113.42", port: 8080 });
    await ctx.proxies.whenProbesIdle();
    expect(calls).toHaveLength(1);

    ctx.proxies.update(p.id, { name: "renamed", group: "eu" });
    await ctx.proxies.whenProbesIdle();
    expect(calls).toHaveLength(1);
    expect(ctx.proxies.get(p.id).lastProbe?.ok).toBe(true);

    const edited = ctx.proxies.update(p.id, { port: 8081 });
    expect(edited.lastProbe).toBeNull();
    await ctx.proxies.whenProbesIdle();
    expect(calls).toEqual(["203.0.113.42:8080", "203.0.113.42:8081"]);
    expect(ctx.proxies.get(p.id).lastProbe?.ok).toBe(true);
  });

  it("a probe still running when the endpoint is edited never overwrites the newer result", async () => {
    const ctx = makeTestContext();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    Reflect.set(ctx.proxies, "background", {
      probe: async (endpoint) => {
        if (endpoint.port === 8080) await gate; // the old endpoint's probe is slow
        return { ...DE, exitIp: `exit-for-${endpoint.port}` };
      },
    } satisfies BackgroundProbeOptions);

    const p = ctx.proxies.create({ name: "race", type: "http", host: "203.0.113.44", port: 8080 });
    ctx.proxies.update(p.id, { port: 9090 }); // queues the new probe while the old one runs
    await new Promise((r) => setTimeout(r, 10));
    release();
    await ctx.proxies.whenProbesIdle();

    expect(ctx.proxies.get(p.id).lastProbe?.exitIp).toBe("exit-for-9090");
  });

  it("profile-form save probes the attached proxy only when its probe is missing or stale", async () => {
    const ctx = makeTestContext();
    const proxy = ctx.proxies.create({ name: "attach", type: "http", host: "203.0.113.43", port: 9000 });
    const calls = withBackground(ctx); // turned on after create: no create-time probe
    const prof = ctx.profiles.create({ name: "pf" });

    ctx.proxies.recordProbe(proxy.id, probeAt(new Date()));
    await ctx.app.inject({ method: "PATCH", url: `/profiles/${prof.id}`, payload: { proxyId: proxy.id } });
    await ctx.proxies.whenProbesIdle();
    expect(calls).toHaveLength(0); // fresh: nothing to do

    ctx.proxies.recordProbe(proxy.id, probeAt(new Date(Date.now() - PROBE_FRESH_MS - 1)));
    await ctx.app.inject({ method: "PATCH", url: `/profiles/${prof.id}`, payload: { proxyId: proxy.id } });
    await ctx.proxies.whenProbesIdle();
    expect(calls).toHaveLength(1);
  });

  it("an import probes at most `concurrency` proxies at once", async () => {
    const ctx = makeTestContext();
    let running = 0;
    let peak = 0;
    Reflect.set(ctx.proxies, "background", {
      concurrency: 2,
      probe: async () => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 5));
        running--;
        return DE;
      },
    } satisfies BackgroundProbeOptions);

    const r = ctx.proxies.importText(["203.0.113.50:1", "203.0.113.51:1", "203.0.113.52:1", "203.0.113.53:1", "203.0.113.54:1"].join("\n"), "http");
    await ctx.proxies.whenProbesIdle();

    expect(r.added).toBe(5);
    expect(peak).toBe(2);
    expect(ctx.proxies.list().every((p) => p.lastProbe?.ok)).toBe(true);
  });

  it("without background options (the default) a save never probes", async () => {
    const ctx = makeTestContext();
    const p = ctx.proxies.create({ name: "quiet", type: "http", host: "203.0.113.60", port: 1 });
    await ctx.proxies.whenProbesIdle();
    expect(ctx.proxies.get(p.id).lastProbe).toBeNull();
  });
});

describe("on-demand re-test", () => {
  it("POST /proxies/:id/test stores and returns the probe", async () => {
    const ctx = makeTestContext();
    withBackground(ctx);
    const p = ctx.proxies.create({ name: "rt", type: "http", host: "203.0.113.70", port: 1 });
    await ctx.proxies.whenProbesIdle();
    ctx.proxies.recordProbe(p.id, probeAt(new Date(Date.now() - PROBE_FRESH_MS * 2)));

    const res = await ctx.app.inject({ method: "POST", url: `/proxies/${p.id}/test` });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.lastProbe).toMatchObject({ ok: true, countryCode: "DE" });
    expect(ctx.proxies.get(p.id).lastProbe!.testedAt).toBe(body.lastProbe.testedAt);
    expect(JSON.stringify(body)).not.toContain("password");
  });
});
