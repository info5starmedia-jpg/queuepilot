import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { makeTestContext } from "./helpers.js";

/**
 * The console's api() helper used to send `content-type: application/json`
 * on EVERY request. Fastify answers a body-less request that claims JSON with
 * a 500, so every body-less call in the console failed: recipe/profile
 * delete, profile stop, proxy test, provider refresh, tab close.
 *
 * These tests run the real api() source from app.js (extracted, evaluated in
 * a vm with fetch routed into the API via inject) — the dashboard is
 * zero-build vanilla JS, so there is no module to import.
 */

const appJs = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "src", "dashboard", "app.js"),
  "utf8",
);
const apiSource = /async function api\([\s\S]*?\n}\n/.exec(appJs)?.[0];
// P9 Task 0: api() sends the operator's token; run the real helpers too.
// P0 audit item 3: api() also silently bootstraps the auto-generated token
// once — those module-level lets and the bootstrap fn must exist in the vm.
const tokenSource = [
  /const TOKEN_KEY = .*\n/.exec(appJs)?.[0],
  /let bootstrapPromise[\s\S]*?\n}\n/.exec(appJs)?.[0],
  /function storedToken\([\s\S]*?\n}\n/.exec(appJs)?.[0],
  /function authHeaders\([\s\S]*?\n}\n/.exec(appJs)?.[0],
].join("\n");

function fakeStorage(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
}

type Call = { path: string; method: string; headers: Record<string, string>; body: string | undefined };

function loadApi(
  ctx: ReturnType<typeof makeTestContext>,
  calls: Call[],
  env: { token?: string; signIns?: string[] } = {},
) {
  const fetch = async (path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    const headers = init.headers ?? {};
    calls.push({ path, method: init.method ?? "GET", headers, body: init.body });
    const res = await ctx.app.inject({
      method: (init.method ?? "GET") as "GET",
      url: path,
      headers,
      ...(init.body === undefined ? {} : { payload: init.body }),
    });
    return {
      status: res.statusCode,
      ok: res.statusCode < 400,
      json: async () => JSON.parse(res.body),
    };
  };
  const sandbox: Record<string, unknown> = {
    fetch,
    sessionStorage: fakeStorage(env.token ? { "queuepilot.apiToken": env.token } : {}),
    localStorage: fakeStorage(),
    showSignIn: (msg: string) => env.signIns?.push(msg),
  };
  vm.runInNewContext(`${tokenSource}\n${apiSource}\nthis.api = api;`, sandbox);
  return sandbox.api as (path: string, opts?: Record<string, unknown>) => Promise<unknown>;
}

describe("dashboard api() helper", () => {
  it("is found in app.js", () => {
    expect(apiSource).toBeTruthy();
  });

  it("sends no JSON content-type on a body-less request, so DELETE/POST work", async () => {
    const ctx = makeTestContext();
    const calls: Call[] = [];
    const api = loadApi(ctx, calls);
    const recipe = (await api("/warmups", {
      method: "POST",
      body: JSON.stringify({ name: "r", steps: [{ url: "https://example.com/", dwellMs: 10 }] }),
    })) as { id: string };
    const p = (await api("/profiles", { method: "POST", body: JSON.stringify({ name: "x" }) })) as {
      id: string;
    };

    await expect(api(`/warmups/${recipe.id}`, { method: "DELETE" })).resolves.toBeNull();
    await expect(api(`/profiles/${p.id}/stop`, { method: "POST" })).resolves.toBeTruthy();
    await expect(api(`/profiles/${p.id}`, { method: "DELETE" })).resolves.toBeNull();

    const bodyless = calls.filter((c) => c.body === undefined);
    expect(bodyless.length).toBeGreaterThan(0);
    for (const c of bodyless) expect(c.headers?.["content-type"]).toBeUndefined();
  });

  it("still sends the JSON content-type when there is a body", async () => {
    const ctx = makeTestContext();
    const calls: Call[] = [];
    const api = loadApi(ctx, calls);
    await api("/profiles", { method: "POST", body: JSON.stringify({ name: "y" }) });
    expect(calls[0]?.headers["content-type"]).toBe("application/json");
  });
});

describe("dashboard token sign-in (P9 Task 0)", () => {
  const tokenCtx = () => makeTestContext(undefined, { apiToken: "operator-token-1" });

  it("the static console loads WITHOUT the token; every API route still demands it", async () => {
    const ctx = tokenCtx();
    expect((await ctx.app.inject({ method: "GET", url: "/" })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: "GET", url: "/?x=1" })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: "GET", url: "/dashboard/app.js" })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: "GET", url: "/dashboard/styles.css" })).statusCode).toBe(200);
    // Not assets: still behind the token.
    for (const url of ["/profiles", "/proxies", "/engine/health", "/events", "/dashboard", "/dashboardx/app.js", "/dashboard/a/b.js"]) {
      expect((await ctx.app.inject({ method: "GET", url })).statusCode, url).toBe(401);
    }
    expect((await ctx.app.inject({ method: "POST", url: "/" })).statusCode).toBe(401);
    expect(
      (await ctx.app.inject({ method: "GET", url: "/profiles", headers: { authorization: "Bearer operator-token-1" } })).statusCode,
    ).toBe(200);
  });

  it("api() sends the stored token as a Bearer header", async () => {
    const ctx = tokenCtx();
    const calls: Call[] = [];
    const api = loadApi(ctx, calls, { token: "operator-token-1" });
    await expect(api("/profiles")).resolves.toMatchObject({ profiles: [] });
    expect(calls[0]?.headers.authorization).toBe("Bearer operator-token-1");
  });

  it("a 401 silently bootstraps the token before any sign-in prompt", async () => {
    const ctx = tokenCtx();
    const signIns: string[] = [];
    // No stored token: the 401 triggers the one-shot bootstrap, the retry
    // carries the bootstrapped token and succeeds — no prompt appears.
    await expect(loadApi(ctx, [], { signIns })("/profiles")).resolves.toMatchObject({
      profiles: [],
    });
    expect(signIns).toEqual([]);
    // A refused (stale) stored token is likewise replaced by the bootstrap
    // on this install — the prompt only appears when the session endpoint
    // has nothing (e.g. a no-token loopback install never 401s at all).
    await expect(
      loadApi(ctx, [], { token: "wrong-token", signIns })("/profiles"),
    ).resolves.toMatchObject({ profiles: [] });
    expect(signIns).toEqual([]);
  });

  it("a loopback install without a token is unaffected: no header, no prompt", async () => {
    const ctx = makeTestContext();
    const calls: Call[] = [];
    const signIns: string[] = [];
    await loadApi(ctx, calls, { signIns })("/profiles");
    expect(calls[0]?.headers.authorization).toBeUndefined();
    expect(signIns).toEqual([]);
  });
});

describe("plugin enable is gated (it is where an imported plugin's code first runs)", () => {
  it("refuses while the scripting gate is closed", async () => {
    const ctx = makeTestContext(undefined, { apiToken: "operator-token-1" });
    const res = await ctx.app.inject({
      method: "POST",
      url: "/plugins/any/enable",
      headers: { authorization: "Bearer operator-token-1" },
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(403);
  });
});
