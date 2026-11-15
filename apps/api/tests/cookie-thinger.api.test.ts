import { describe, expect, it, afterEach } from "vitest";
import { makeTestContext, type TestContext } from "./helpers.js";
import { FakeBrowserRuntime } from "../src/application/runtime/fake.browser-runtime.js";
import { MockCdpServer } from "./helpers/mock-cdp-server.js";

/**
 * Cookie Thinger (v0.14.9): list/set/clear a running profile's cookies
 * over CDP, whole-run or scoped to one session partition.
 */

const COOKIES = [
  { name: "session", value: "abc", domain: ".shop.example", path: "/", expires: 0, secure: false, httpOnly: true },
  { name: "pref", value: "dark", domain: ".example.com", path: "/", expires: 1893456000, secure: true, httpOnly: false },
];

let ctx: TestContext;
let mock: MockCdpServer;
let runtime: FakeBrowserRuntime;

async function boot() {
  runtime = new FakeBrowserRuntime();
  mock = new MockCdpServer();
  mock.allCookies = COOKIES.map((c) => ({ ...c }));
  const { wsUrl } = await mock.start();
  runtime.nextWsEndpoint = wsUrl;
  ctx = makeTestContext(runtime);
  return ctx.profiles.create({ name: "ck", generateFingerprint: true });
}

afterEach(async () => {
  await mock.stop();
});

describe("GET /profiles/:id/cookies", () => {
  it("lists all cookies of the run and filters by domain wildcard", async () => {
    const p = await boot();
    await ctx.lifecycle.start(p.id);

    const all = await ctx.app.inject({ method: "GET", url: `/profiles/${p.id}/cookies` });
    expect(all.statusCode).toBe(200);
    expect(all.json().total).toBe(2);

    const filtered = await ctx.app.inject({
      method: "GET",
      url: `/profiles/${p.id}/cookies?domain=*.shop.example`,
    });
    expect(filtered.json().cookies.map((c: { name: string }) => c.name)).toEqual(["session"]);

    await ctx.lifecycle.stop(p.id);
  });

  it("scopes the list to a partition via its live tabs' contexts", async () => {
    const p = await boot();
    await ctx.lifecycle.start(p.id);
    const tab = await ctx.lifecycle.openTab(p.id, { url: "https://shop.example" });
    mock.pageTargets = [
      { targetId: tab.engineTabId!, type: "page", browserContextId: "ctx-9" },
    ];
    mock.contextCookies.set("ctx-9", [COOKIES[0]!]);

    const res = await ctx.app.inject({
      method: "GET",
      url: `/profiles/${p.id}/cookies?partitionId=${tab.partitionId}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(1);
    expect(res.json().cookies[0].browserContextId).toBe("ctx-9");
    expect(mock.callsFor("Network.getCookies")[0]!.params.browserContextId).toBe("ctx-9");

    await ctx.lifecycle.stop(p.id);
  });

  it("409s when the partition has no open tabs", async () => {
    const p = await boot();
    await ctx.lifecycle.start(p.id);
    const other = "99999999-9999-4999-8999-999999999999";
    const res = await ctx.app.inject({
      method: "GET",
      url: `/profiles/${p.id}/cookies?partitionId=${other}`,
    });
    expect(res.statusCode).toBe(409);
    await ctx.lifecycle.stop(p.id);
  });

  it("409s when the profile is not running", async () => {
    const p = await boot();
    const res = await ctx.app.inject({ method: "GET", url: `/profiles/${p.id}/cookies` });
    expect(res.statusCode).toBe(409);
  });
});

describe("GET /profiles/:id/cookies redaction (audit A5, v0.15.0)", () => {
  it("redacts every cookie value by default", async () => {
    const p = await boot();
    await ctx.lifecycle.start(p.id);
    const res = await ctx.app.inject({ method: "GET", url: `/profiles/${p.id}/cookies` });
    expect(res.statusCode).toBe(200);
    expect(res.json().revealed).toBe(false);
    expect(res.json().cookies).toHaveLength(2);
    for (const c of res.json().cookies) expect(c.value).toBe("***");
    // metadata survives redaction
    expect(res.json().cookies.find((c: { name: string }) => c.name === "session")).toMatchObject({
      domain: ".shop.example",
      httpOnly: true,
    });
    await ctx.lifecycle.stop(p.id);
  });

  it("refuses reveal=raw with 403 when no API token is configured", async () => {
    const p = await boot();
    await ctx.lifecycle.start(p.id);
    const res = await ctx.app.inject({
      method: "GET",
      url: `/profiles/${p.id}/cookies?reveal=raw`,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
    await ctx.lifecycle.stop(p.id);
  });

  it("serves reveal=raw when the install runs with SPECTRA_API_TOKEN", async () => {
    runtime = new FakeBrowserRuntime();
    mock = new MockCdpServer();
    mock.allCookies = COOKIES.map((c) => ({ ...c }));
    const { wsUrl } = await mock.start();
    runtime.nextWsEndpoint = wsUrl;
    // Token-configured install: the bearer hook applies to every request,
    // and raw export is the operator's explicit opt-in.
    ctx = makeTestContext(runtime, { apiToken: "test-token-16" });
    const p = ctx.profiles.create({ name: "ck-raw", generateFingerprint: true });
    await ctx.lifecycle.start(p.id);

    const denied = await ctx.app.inject({
      method: "GET",
      url: `/profiles/${p.id}/cookies?reveal=raw`,
    });
    expect(denied.statusCode).toBe(401);

    const res = await ctx.app.inject({
      method: "GET",
      url: `/profiles/${p.id}/cookies?reveal=raw`,
      headers: { authorization: "Bearer test-token-16" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().revealed).toBe(true);
    expect(res.json().cookies.find((c: { name: string }) => c.name === "session").value).toBe("abc");

    await ctx.lifecycle.stop(p.id);
  });
});

describe("POST /profiles/:id/cookies", () => {
  it("sets a cookie browser-level by default", async () => {
    const p = await boot();
    await ctx.lifecycle.start(p.id);

    const res = await ctx.app.inject({
      method: "POST",
      url: `/profiles/${p.id}/cookies`,
      payload: { name: "sess2", value: "xyz", domain: ".example.com", httpOnly: true },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().partitionScoped).toBe(false);
    expect(mock.setCookieCalls).toHaveLength(1);
    expect(mock.setCookieCalls[0]).toMatchObject({ name: "sess2", value: "xyz" });

    await ctx.lifecycle.stop(p.id);
  });

  it("sets through a live page when a partition is named", async () => {
    const p = await boot();
    await ctx.lifecycle.start(p.id);
    const tab = await ctx.lifecycle.openTab(p.id, { url: "https://shop.example" });
    mock.pageTargets = [
      { targetId: tab.engineTabId!, type: "page", browserContextId: "ctx-9" },
    ];

    const res = await ctx.app.inject({
      method: "POST",
      url: `/profiles/${p.id}/cookies`,
      payload: {
        name: "scoped",
        value: "1",
        domain: ".shop.example",
        partitionId: tab.partitionId,
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().partitionScoped).toBe(true);
    // The set went out on the attached page session, not browser-level.
    const setCall = mock.calls.find(
      (c) => c.method === "Network.setCookie" && c.params.name === "scoped",
    )!;
    expect(setCall).toBeDefined();
    expect(mock.callsFor("Target.attachToTarget").length).toBeGreaterThan(0);

    await ctx.lifecycle.stop(p.id);
  });
});

describe("POST /profiles/:id/cookies/clear", () => {
  it("deletes every cookie matching the domain filter", async () => {
    const p = await boot();
    await ctx.lifecycle.start(p.id);

    const res = await ctx.app.inject({
      method: "POST",
      url: `/profiles/${p.id}/cookies/clear`,
      payload: { domain: "*.example.com" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().matched).toBe(1);
    expect(mock.deleteCookieCalls).toHaveLength(1);
    expect(mock.deleteCookieCalls[0]).toMatchObject({ name: "pref", domain: ".example.com" });

    await ctx.lifecycle.stop(p.id);
  });

  it("refuses to clear without any filter (no whole-jar wipe)", async () => {
    const p = await boot();
    await ctx.lifecycle.start(p.id);
    const res = await ctx.app.inject({
      method: "POST",
      url: `/profiles/${p.id}/cookies/clear`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(mock.deleteCookieCalls).toHaveLength(0);
    await ctx.lifecycle.stop(p.id);
  });
});

describe("POST /profiles/:id/cookies/load (v0.14.12)", () => {
  it("bulk-loads cookies into the default store with per-cookie results", async () => {
    const p = await boot();
    await ctx.lifecycle.start(p.id);

    const res = await ctx.app.inject({
      method: "POST",
      url: `/profiles/${p.id}/cookies/load`,
      payload: {
        cookies: [
          { name: "a", value: "1", domain: ".example.com" },
          { name: "b", value: "2", domain: ".example.com", secure: true },
        ],
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().set).toBe(2);
    expect(res.json().partitionScoped).toBe(false);
    expect(mock.callsFor("Network.setCookie")).toHaveLength(2);

    await ctx.lifecycle.stop(p.id);
  });

  it("scopes the load to a partition through its open tab's context", async () => {
    const p = await boot();
    await ctx.lifecycle.start(p.id);
    const tab = await ctx.lifecycle.openTab(p.id, { url: "https://shop.example" });
    mock.pageTargets = [
      { targetId: tab.engineTabId!, type: "page", browserContextId: "ctx-9" },
    ];

    const res = await ctx.app.inject({
      method: "POST",
      url: `/profiles/${p.id}/cookies/load`,
      payload: {
        cookies: [{ name: "cart", value: "3", domain: ".shop.example" }],
        partitionId: tab.partitionId,
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().partitionScoped).toBe(true);
    // The set went out on an attached page session, not browser-level —
    // same evidence as the single-cookie partition path.
    expect(mock.callsFor("Target.attachToTarget").length).toBeGreaterThan(0);

    await ctx.lifecycle.stop(p.id);
  });

  it("409s when the named partition has no open tabs", async () => {
    const p = await boot();
    await ctx.lifecycle.start(p.id);
    const res = await ctx.app.inject({
      method: "POST",
      url: `/profiles/${p.id}/cookies/load`,
      payload: {
        cookies: [{ name: "x", value: "1", domain: ".example.com" }],
        partitionId: "99999999-9999-4999-8999-999999999999",
      },
    });
    expect(res.statusCode).toBe(409);

    await ctx.lifecycle.stop(p.id);
  });
});
