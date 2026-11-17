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

type Call = { path: string; method: string; headers: Record<string, string>; body: string | undefined };

function loadApi(ctx: ReturnType<typeof makeTestContext>, calls: Call[]) {
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
  const sandbox: Record<string, unknown> = { fetch };
  vm.runInNewContext(`${apiSource}\nthis.api = api;`, sandbox);
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
