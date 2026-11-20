import { describe, expect, it } from "vitest";
import { makeTestContext } from "./helpers.js";
import { PersonaWarmupService } from "../src/application/warmups/persona-warmup.service.js";
import type { Driver } from "../src/application/warmups/persona/driver/Driver.js";

/**
 * W — the owner's warmup engine on QueuePilot profiles. A stand-in Driver
 * records what the engine does; the real CdpDriver is exercised live.
 */
function fakeDriver(log: string[]): Driver {
  let url = "about:blank";
  return {
    kind: "browser",
    async goto(u) { url = u; log.push(`goto ${new URL(u).host}`); return { url: u, title: "t", ok: true, status: 200 }; },
    async currentUrl() { return url; },
    async scroll() { log.push("scroll"); },
    async collectLinks() {
      const base = new URL(url);
      return [1, 2, 3].map((i) => ({ href: `${base.origin}/page-${i}`, text: `p${i}`, internal: true }));
    },
    async click(l) { url = l.href; log.push("click"); return { url: l.href, title: "t", ok: true, status: 200 }; },
    async back() {},
    async handleConsent() { return false; },
    async wander() {},
    async snapshotStorage() { return { cookies: [], domains: [], localStorageKeys: 0, historyDepth: 1, takenAt: Date.now() }; },
    async dispose() { log.push("dispose"); },
  };
}

describe("persona warmup (owner's engine)", () => {
  it("starts an idle profile, runs a session with the default persona, stops it again", async () => {
    const ctx = makeTestContext();
    const p = ctx.profiles.create({ name: "warm", generateFingerprint: true });
    const log: string[] = [];
    const svc = new PersonaWarmupService({
      lifecycle: ctx.lifecycle,
      personaDirs: [],
      driverFactory: () => fakeDriver(log),
      sleep: async () => {},
    });
    expect(svc.personas().map((x) => x.id)).toContain("us-shopper");
    const st = svc.start(p.id, { sessions: 1 });
    expect(st).toMatchObject({ state: "running", persona: "us-shopper", sessionsPlanned: 1 });
    for (let i = 0; i < 200 && svc.statusOf(p.id)!.state === "running"; i++) await new Promise((r) => setTimeout(r, 10));
    const done = svc.statusOf(p.id)!;
    expect(done.state).toBe("done");
    expect(done.sessionsDone).toBe(1);
    expect(done.visits).toBeGreaterThan(0);
    expect(log.some((l) => l.startsWith("goto"))).toBe(true);
    expect(log.at(-1)).toBe("dispose");
    expect(ctx.lifecycle.activeRun(p.id)).toBeNull(); // was idle → stopped again
  }, 20000);

  it("refuses an unknown persona and a second run on the same profile", () => {
    const ctx = makeTestContext();
    const p = ctx.profiles.create({ name: "warm2", generateFingerprint: true });
    const svc = new PersonaWarmupService({ lifecycle: ctx.lifecycle, personaDirs: [], driverFactory: () => fakeDriver([]), sleep: () => new Promise(() => {}) });
    expect(() => svc.start(p.id, { persona: "nope" })).toThrow(/unknown persona/);
    svc.start(p.id);
    expect(() => svc.start(p.id)).toThrow(/already running/);
  });

  it("exposes routes: list personas, start, status", async () => {
    const ctx = makeTestContext();
    const r = await ctx.app.inject({ method: "GET", url: "/warmups/personas" });
    expect(r.statusCode).toBe(200);
    expect(r.json().personas.map((x: { id: string }) => x.id)).toEqual(expect.arrayContaining(["us-shopper", "crypto-heavy"]));
    const s = await ctx.app.inject({ method: "GET", url: "/profiles/00000000-0000-4000-8000-000000000000/warmup/persona" });
    expect(s.json()).toEqual({ status: null });
  });
});

describe("persona site settings", () => {
  it("excludes, adds and persists sites per persona; refuses bad input", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const ctx = makeTestContext();
    const file = join(mkdtempSync(join(tmpdir(), "qp-ps-")), "persona-sites.json");
    const svc = new PersonaWarmupService({ lifecycle: ctx.lifecycle, personaDirs: [], siteSettingsFile: file, sleep: async () => {} });
    const before = svc.personas().find((p) => p.id === "us-shopper")!;
    expect(before.sites.some((s) => s.url.includes("walmart"))).toBe(true);

    svc.setSiteSettings("us-shopper", { excluded: ["walmart.com"], added: [{ url: "https://www.newegg.com", category: "shopping" }] });
    const after = new PersonaWarmupService({ lifecycle: ctx.lifecycle, personaDirs: [], siteSettingsFile: file }).personas().find((p) => p.id === "us-shopper")!;
    expect(after.sites.some((s) => s.url.includes("walmart"))).toBe(false);
    expect(after.sites.some((s) => s.url === "https://www.newegg.com")).toBe(true);

    expect(() => svc.setSiteSettings("us-shopper", { added: [{ url: "http://127.0.0.1:50325" }] })).toThrow(/public/);
    expect(() => svc.setSiteSettings("us-shopper", { excluded: ["bad host/../x"] })).toThrow(/hostname/);
    expect(() => svc.setSiteSettings("nope", {})).toThrow(/unknown persona/);

    const all = before.sites.map((s) => new URL(s.url).hostname);
    svc.setSiteSettings("us-shopper", { excluded: all });
    const p = ctx.profiles.create({ name: "none-left", generateFingerprint: true });
    expect(() => svc.start(p.id)).toThrow(/every site/);
  });

  it("routes list sites with their excluded flag and save settings", async () => {
    const ctx = makeTestContext();
    const r = await ctx.app.inject({ method: "GET", url: "/warmups/personas/us-shopper/sites" });
    expect(r.statusCode).toBe(200);
    expect(r.json().sites.length).toBeGreaterThan(5);
    const put = await ctx.app.inject({ method: "PUT", url: "/warmups/personas/us-shopper/sites", payload: { excluded: ["espn.com"], added: [] } });
    expect(put.statusCode).toBe(200);
    const r2 = await ctx.app.inject({ method: "GET", url: "/warmups/personas/us-shopper/sites" });
    expect(r2.json().sites.find((s: { host: string }) => s.host === "espn.com")?.excluded).toBe(true);
    const bad = await ctx.app.inject({ method: "PUT", url: "/warmups/personas/us-shopper/sites", payload: { added: [{ url: "file:///C:/x" }] } });
    expect(bad.statusCode).toBe(400);
  });
});

describe("W2 — plans and site settings from the team server", () => {
  it("runs a server-planned warmup; site settings go to the server; the local planner is unused", async () => {
    const { buildTeamServerApp } = await import("@queuepilot/server");
    const server = buildTeamServerApp({ host: "127.0.0.1", port: 0, dbPath: ":memory:", adminToken: "boot", machineName: "t" });
    await server.app.listen({ host: "127.0.0.1", port: 0 });
    const base = `http://127.0.0.1:${(server.app.server.address() as { port: number }).port}`;
    try {
      const acct = server.store.createAccount("tester-1", null);
      const { token } = server.store.mintToken("pc", "operator", acct.id);
      const ctx = makeTestContext();
      ctx.settings.patch("team", { serverUrl: base, token });

      // Console routes now read from and write to the server, per account.
      const put = await ctx.app.inject({ method: "PUT", url: "/warmups/personas/us-shopper/sites", payload: { excluded: ["espn.com"] } });
      expect(put.statusCode).toBe(200);
      expect(server.store.getSiteSettings(acct.id, "us-shopper")).toMatchObject({ excluded: ["espn.com"] });
      const view = (await ctx.app.inject({ method: "GET", url: "/warmups/personas/us-shopper/sites" })).json();
      expect(view.sites.find((s: { host: string }) => s.host === "espn.com").excluded).toBe(true);

      const { TeamServerClient } = await import("../src/application/team/team-client.js");
      const log: string[] = [];
      const svc = new PersonaWarmupService({
        lifecycle: ctx.lifecycle,
        personaDirs: [],
        driverFactory: () => fakeDriver(log),
        sleep: async () => {},
        exitCountry: async () => "CA",
        remote: () => new TeamServerClient(base, token),
      });
      const p = ctx.profiles.create({ name: "remote-warm", generateFingerprint: true });
      svc.start(p.id, { sessions: 1 });
      for (let i = 0; i < 300 && svc.statusOf(p.id)!.state === "running"; i++) await new Promise((r) => setTimeout(r, 10));
      const st = svc.statusOf(p.id)!;
      expect(st.error).toBeNull();
      expect(st.state).toBe("done");
      expect(st.visits).toBeGreaterThan(0);
      expect(log.some((l) => l === "goto www.espn.com")).toBe(false); // excluded on the server
    } finally {
      await server.close();
    }
  }, 20000);

  it("refuses a server plan that points anywhere but public websites", async () => {
    const { checkRemotePlan } = await import("../src/application/warmups/persona-warmup.service.js");
    const visit = { site: "x", url: "https://www.example.com", category: "general", entry: "direct", dwellMs: 1000, hops: 1 };
    const session = { searchEngine: "https://www.google.com/search?q=", visits: [visit] };
    expect(checkRemotePlan([session], 1)).toHaveLength(1);
    for (const bad of [
      [{ ...session, visits: [{ ...visit, url: "http://127.0.0.1:50325/profiles" }] }],
      [{ ...session, visits: [{ ...visit, url: "file:///C:/x" }] }],
      [{ ...session, visits: [{ ...visit, productSearchUrl: "http://192.168.1.1/" }] }],
      [{ ...session, searchEngine: "http://localhost/?q=" }],
      [{ ...session, visits: [{ ...visit, dwellMs: -1 }] }],
      // engine + query composed into a local address
      [{ ...session, searchEngine: "https://a.local", visits: [{ ...visit, entry: "search", searchQuery: "host" }] }],
      [{ ...session, searchEngine: "https://www.google.com/?x=", visits: [{ ...visit, entry: "search", searchQuery: "q".repeat(101) }] }],
      [{ ...session, visits: [{ ...visit, entry: "teleport" }] }],
      [{ ...session, visits: [{ ...visit, url: "http://localhost.:50325/" }] }],
      [session, session],
      [],
      "nope",
    ]) {
      expect(() => checkRemotePlan(bad, 1)).toThrow(/invalid warmup plan/);
    }
  });
});
