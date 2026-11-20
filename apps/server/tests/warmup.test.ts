import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { buildTeamServerApp, type TeamServerApp } from "../src/app.js";

/** W2 — personas, site settings and plans live on the server, per account. */

const ADMIN = "bootstrap-secret";

describe("warmup planning on the server", () => {
  let server: TeamServerApp;
  let base: string;

  beforeEach(async () => {
    server = buildTeamServerApp({ host: "127.0.0.1", port: 0, dbPath: ":memory:", adminToken: ADMIN, machineName: "t" });
    await server.app.listen({ host: "127.0.0.1", port: 0 });
    base = `http://127.0.0.1:${(server.app.server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await server.close();
  });

  async function call(method: string, p: string, token: string | null, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    return fetch(`${base}${p}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  }

  async function key(name: string): Promise<{ id: string; key: string }> {
    const a = (await (await call("POST", "/accounts", ADMIN, { name })).json()) as { id: string; invite: string };
    const k = (await (await call("POST", "/redeem", null, { invite: a.invite })).json()) as { token: string };
    return { id: a.id, key: k.token };
  }

  it("lists personas and returns a plan of concrete visits", async () => {
    const a = await key("tester-1");
    const list = (await (await call("GET", "/warmup/personas", a.key)).json()) as { personas: { id: string }[] };
    expect(list.personas.map((p) => p.id)).toEqual(expect.arrayContaining(["us-shopper", "crypto-heavy"]));

    const r = await call("POST", "/warmup/plan", a.key, { persona: "us-shopper", sessions: 1, target: "abc123" });
    expect(r.status).toBe(200);
    const plan = (await r.json()) as { personaId: string; sessions: { visits: { url: string; dwellMs: number }[] }[] };
    expect(plan.personaId).toBe("us-shopper");
    expect(plan.sessions).toHaveLength(1);
    expect(plan.sessions[0]!.visits.length).toBeGreaterThan(0);
    expect(plan.sessions[0]!.visits.every((v) => /^https:\/\//.test(v.url) && v.dwellMs > 0)).toBe(true);
    // Only the visits: no persona definition or site list travels with the plan.
    expect(JSON.stringify(plan)).not.toContain("searchTerms");
  });

  it("localises visits to the exit-IP country", async () => {
    const a = await key("tester-1");
    // Only Best Buy left, so the plan certainly visits it.
    const sites = (await (await call("GET", "/warmup/personas/us-shopper/sites", a.key)).json()) as { sites: { host: string }[] };
    const excluded = sites.sites.map((s) => s.host).filter((h) => h !== "bestbuy.com");
    expect((await call("PUT", "/warmup/personas/us-shopper/sites", a.key, { excluded })).status).toBe(200);
    const plan = (await (await call("POST", "/warmup/plan", a.key, { persona: "us-shopper", country: "CA", target: "t1" })).json()) as {
      sessions: { visits: { url: string }[] }[];
    };
    const urls = plan.sessions.flatMap((s) => s.visits.map((v) => v.url));
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((u) => u === "https://www.bestbuy.ca")).toBe(true);
  });

  it("site settings are per account; another account is unaffected", async () => {
    const a = await key("tester-1");
    const b = await key("tester-2");
    await call("PUT", "/warmup/personas/us-shopper/sites", a.key, { excluded: ["espn.com"], added: [{ url: "https://www.newegg.com" }] });
    const aSites = (await (await call("GET", "/warmup/personas/us-shopper/sites", a.key)).json()) as { excluded: string[]; added: unknown[] };
    const bSites = (await (await call("GET", "/warmup/personas/us-shopper/sites", b.key)).json()) as { excluded: string[]; added: unknown[] };
    expect(aSites.excluded).toEqual(["espn.com"]);
    expect(aSites.added).toHaveLength(1);
    expect(bSites.excluded).toEqual([]);
    expect(bSites.added).toEqual([]);
  });

  it("duplicate added sites and a tiny pool cannot hang the planner (audit HIGH)", async () => {
    const a = await key("tester-1");
    const sites = (await (await call("GET", "/warmup/personas/us-shopper/sites", a.key)).json()) as { sites: { host: string }[] };
    const put = await call("PUT", "/warmup/personas/us-shopper/sites", a.key, {
      excluded: sites.sites.map((s) => s.host),
      added: [{ url: "https://a.example.com" }, { url: "https://a.example.com" }, { url: "https://www.a.example.com/x" }],
    });
    expect(put.status).toBe(200);
    const started = Date.now();
    const r = await call("POST", "/warmup/plan", a.key, { target: "t", sessions: 1 });
    expect(r.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(5000);
    const plan = (await r.json()) as { sessions: { visits: { url: string }[] }[] };
    expect(plan.sessions[0]!.visits.length).toBe(1);
  });

  it("rejects local-network addresses in any disguise", async () => {
    const a = await key("tester-1");
    for (const url of [
      "http://localhost.:50325/",
      "http://foo.localhost./",
      "http://printer.local/",
      "http://svc.internal/",
      "http://nas.lan/",
      "http://x.localtest.me/",
      "http://100.64.0.1/",
      "http://0.1.2.3/",
      "http://[::ffff:127.0.0.1]/",
      "https://a.example.com/" + "x".repeat(2100),
    ]) {
      const r = await call("PUT", "/warmup/personas/us-shopper/sites", a.key, { added: [{ url }] });
      expect(r.status, url).toBe(400);
    }
    const big = { added: [{ url: "https://a.example.com", searchTerms: Array.from({ length: 21 }, () => "q") }] };
    expect((await call("PUT", "/warmup/personas/us-shopper/sites", a.key, big)).status).toBe(400);
  });

  it("refuses bad sites, unknown personas, an all-excluded persona, admins and viewers", async () => {
    const a = await key("tester-1");
    expect((await call("PUT", "/warmup/personas/us-shopper/sites", a.key, { added: [{ url: "http://127.0.0.1:50325" }] })).status).toBe(400);
    expect((await call("GET", "/warmup/personas/nope/sites", a.key)).status).toBe(404);
    expect((await call("POST", "/warmup/plan", a.key, { persona: "nope", target: "t" })).status).toBe(404);
    expect((await call("POST", "/warmup/plan", a.key, { target: "bad target!" })).status).toBe(400);

    const sites = (await (await call("GET", "/warmup/personas/us-shopper/sites", a.key)).json()) as { sites: { host: string; pool: string }[] };
    await call("PUT", "/warmup/personas/us-shopper/sites", a.key, { excluded: sites.sites.filter((s) => s.pool === "main").map((s) => s.host) });
    expect((await call("POST", "/warmup/plan", a.key, { target: "t" })).status).toBe(400);

    for (const p of ["/warmup/personas", "/warmup/personas/us-shopper/sites"]) expect((await call("GET", p, ADMIN)).status).toBe(403);
    expect((await call("POST", "/warmup/plan", ADMIN, { target: "t" })).status).toBe(403);

    const v = (await (await call("POST", "/licence/keys", a.key, { name: "ro", role: "viewer" })).json()) as { token: string };
    expect((await call("GET", "/warmup/personas", v.token)).status).toBe(200);
    expect((await call("POST", "/warmup/plan", v.token, { target: "t" })).status).toBe(403);
    expect((await call("PUT", "/warmup/personas/us-shopper/sites", v.token, {})).status).toBe(403);
  });
});
