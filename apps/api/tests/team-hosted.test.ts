import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildTeamServerApp, type TeamServerApp } from "@queuepilot/server";
import { BundleService } from "../src/application/bundles/bundle.service.js";
import { TeamServerClient, teamCredential } from "../src/application/team/team-client.js";
import { TeamSyncService } from "../src/application/team/team-sync.js";
import { TeamSyncLoop, storeOnCloudOff } from "../src/application/team/team-sync-loop.js";
import { makeTestContext, type TestContext } from "./helpers.js";

/**
 * Hosted team client (2026-11-18): the token-source rule, the local /team/*
 * relay routes against a REAL team server, and the per-profile
 * "Store on cloud" sync filter.
 */

describe("teamCredential (token source)", () => {
  const now = Date.parse("2026-11-18T00:00:00Z");
  it("prefers an unexpired session token over the device token", () => {
    expect(
      teamCredential({ token: "qpt_dev", sessionToken: "qps_s", sessionExpiresAt: "2026-12-01T00:00:00Z" }, now),
    ).toEqual({ token: "qps_s", source: "session" });
  });
  it("falls back to the device token once the session has expired", () => {
    expect(
      teamCredential({ token: "qpt_dev", sessionToken: "qps_s", sessionExpiresAt: "2026-11-01T00:00:00Z" }, now),
    ).toEqual({ token: "qpt_dev", source: "device" });
  });
  it("is null with no credential at all (team mode off)", () => {
    expect(teamCredential({ token: null, sessionToken: null, sessionExpiresAt: null }, now)).toBeNull();
    expect(teamCredential({ token: null }, now)).toBeNull();
  });
});

const BOOTSTRAP = "bootstrap-code-for-tests";
const OWNER = { email: "owner@example.test", password: "owner-password-1", displayName: "Owner" };

describe("/team/* relay routes", () => {
  let server: TeamServerApp;
  let base: string;
  let ctx: TestContext;

  beforeEach(async () => {
    server = buildTeamServerApp({
      host: "127.0.0.1",
      port: 0,
      dbPath: ":memory:",
      adminToken: null,
      machineName: "test",
      bootstrapCode: BOOTSTRAP,
    } as Parameters<typeof buildTeamServerApp>[0]);
    await server.app.listen({ host: "127.0.0.1", port: 0 });
    base = `http://127.0.0.1:${(server.app.server.address() as AddressInfo).port}`;
    const boot = await fetch(`${base}/auth/bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: BOOTSTRAP, ...OWNER }),
    });
    expect(boot.status).toBe(201);
    ctx = makeTestContext();
  });

  afterEach(async () => {
    await ctx.app.close();
    await server.close();
  });

  const get = (url: string) => ctx.app.inject({ method: "GET", url });
  const send = (method: "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) =>
    ctx.app.inject({ method, url, ...(payload === undefined ? {} : { payload: payload as object }) });

  async function signInOwner() {
    ctx.settings.patch("team", { serverUrl: base });
    const res = await send("POST", "/team/signin", { email: OWNER.email, password: OWNER.password });
    expect(res.statusCode).toBe(200);
    return res.json();
  }

  /** Mint an invite as owner and redeem it on the server → a member account. */
  async function addMember(role: "L1" | "L2" | "L3", email: string) {
    const inv = await send("POST", "/team/invites", { role });
    expect(inv.statusCode).toBe(201);
    const r = await fetch(`${base}/auth/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: inv.json().code, email, password: "member-password-1", displayName: email }),
    });
    expect(r.status).toBe(201);
    return (await r.json()) as { token: string; account: { id: string } };
  }

  it("with no server configured, /team/session reports offline and nothing else changes", async () => {
    const res = await get("/team/session");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ configured: false, source: null, account: null });
  });

  it("server set + no credential: session says sign-in is needed", async () => {
    ctx.settings.patch("team", { serverUrl: base });
    expect((await get("/team/session")).json()).toMatchObject({ configured: true, source: null, account: null });
  });

  it("wrong credentials come back as plain text, never as a local 401", async () => {
    ctx.settings.patch("team", { serverUrl: base });
    const res = await send("POST", "/team/signin", { email: OWNER.email, password: "not-the-password" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toEqual({ code: "INVALID_CREDENTIALS", message: "wrong email or password" });
    expect(ctx.settings.get("team").sessionToken).toBeNull();
  });

  it("sign-in stores the qps_ session; /team/session resolves the owner; sign-out clears it", async () => {
    const out = await signInOwner();
    expect(out.account.tier).toBe("owner");
    const team = ctx.settings.get("team");
    expect(team.sessionToken).toMatch(/^qps_/);
    expect(team.sessionExpiresAt).toBeTruthy();

    const s = (await get("/team/session")).json();
    expect(s).toMatchObject({ configured: true, source: "session", reachable: true });
    expect(s.account.email).toBe(OWNER.email);
    expect(JSON.stringify(s)).not.toContain("qps_"); // the token never reaches the browser via this route

    const so = await send("POST", "/team/signout");
    expect(so.statusCode).toBe(200);
    expect(ctx.settings.get("team").sessionToken).toBeNull();
    expect((await get("/team/session")).json().source).toBeNull();
  });

  it("a session revoked server-side is dropped and sign-in is offered again", async () => {
    await signInOwner();
    const token = ctx.settings.get("team").sessionToken!;
    await new TeamServerClient(base, token).signOut();
    const s = (await get("/team/session")).json();
    expect(s.source).toBeNull();
    expect(s.message).toMatch(/sign in again/);
    expect(ctx.settings.get("team").sessionToken).toBeNull();
  });

  it("owner team management: invites, members, role change, deactivate, remove, revoke", async () => {
    await signInOwner();
    const member = await addMember("L2", "editor@example.test");

    const members = (await get("/team/members")).json();
    expect(members.cap).toBe(10);
    expect(members.members.map((m: { email: string }) => m.email).sort()).toEqual([
      "editor@example.test",
      OWNER.email,
    ]);

    const role = await send("PATCH", `/team/members/${member.account.id}`, { role: "L1" });
    expect(role.statusCode).toBe(200);
    expect(role.json().account.tier).toBe("L1");

    const off = await send("PATCH", `/team/members/${member.account.id}`, { active: false });
    expect(off.json().account.active).toBe(false);
    const on = await send("PATCH", `/team/members/${member.account.id}`, { active: true });
    expect(on.json().account.active).toBe(true);

    const pending = await send("POST", "/team/invites", { role: "L3" });
    const inviteId = pending.json().invite.id as string;
    expect((await get("/team/invites")).json().invites.some((i: { id: string }) => i.id === inviteId)).toBe(true);
    expect((await send("DELETE", `/team/invites/${inviteId}`)).statusCode).toBe(200);

    expect((await send("DELETE", `/team/members/${member.account.id}`)).statusCode).toBe(200);
    expect((await get("/team/members")).json().members).toHaveLength(1);
  });

  it("owner-immutable and invalid input surface plainly", async () => {
    await signInOwner();
    const ownerId = (await get("/team/session")).json().account.id as string;
    const res = await send("PATCH", `/team/members/${ownerId}`, { role: "L1" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("OWNER_IMMUTABLE");
    expect(res.json().error.message).toMatch(/owner account cannot be edited/);
    expect((await send("POST", "/team/invites", { role: "owner" })).statusCode).toBe(400);
  });

  it("TEAM_FULL passes through once active members + outstanding invites hit the cap", async () => {
    await signInOwner();
    for (let i = 0; i < 9; i++) expect((await send("POST", "/team/invites", { role: "L1" })).statusCode).toBe(201);
    const full = await send("POST", "/team/invites", { role: "L1" });
    expect(full.statusCode).toBe(409);
    expect(full.json().error.code).toBe("TEAM_FULL");
    expect(full.json().error.message).toMatch(/capped at 10/);
  });

  it("a non-owner session is refused team management with 403 (not 401)", async () => {
    await signInOwner();
    const staff = await addMember("L1", "staff@example.test");
    ctx.settings.patch("team", { sessionToken: staff.token, sessionExpiresAt: null });
    const s = (await get("/team/session")).json();
    expect(s.account.tier).toBe("L1");
    const res = await get("/team/members");
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
  });

  it("an unreachable server is 502 TEAM_UNAVAILABLE on sign-in and reachable:false on session", async () => {
    ctx.settings.patch("team", { serverUrl: "http://127.0.0.1:9", token: "qpt_whatever" });
    const res = await send("POST", "/team/signin", { email: OWNER.email, password: OWNER.password });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe("TEAM_UNAVAILABLE");
    expect((await get("/team/session")).json()).toMatchObject({ source: "device", reachable: false });
  });
});

describe("Store on cloud (per-profile sync filter)", () => {
  it("persists through the persona route and drives storeOnCloudOff", async () => {
    const ctx = makeTestContext();
    const p = ctx.profiles.create({ name: "cloud-toggle", generateFingerprint: true });
    expect(storeOnCloudOff(ctx.profiles, p.id)).toBe(false); // default on
    const res = await ctx.app.inject({
      method: "PATCH",
      url: `/profiles/${p.id}/persona`,
      payload: { storeOnCloud: false },
    });
    expect(res.statusCode).toBe(200);
    expect(ctx.profiles.get(p.id).extra.storeOnCloud).toBe(false);
    expect(storeOnCloudOff(ctx.profiles, p.id)).toBe(true);
    expect(storeOnCloudOff(ctx.profiles, "00000000-0000-4000-8000-000000000000")).toBe(false); // unknown id syncs
    await ctx.app.close();
  });

  it("the sync loop skips heads the filter rejects and pulls the rest", async () => {
    const server = buildTeamServerApp({
      host: "127.0.0.1",
      port: 0,
      dbPath: ":memory:",
      adminToken: "admin-secret",
      machineName: "test",
    });
    await server.app.listen({ host: "127.0.0.1", port: 0 });
    const base = `http://127.0.0.1:${(server.app.server.address() as AddressInfo).port}`;
    try {
      const a = makeTestContext();
      const bundlesA = new BundleService(a.profiles, a.lifecycle, {
        export: async () => [],
        import: async () => {},
      }, a.proxies);
      const sync = new TeamSyncService(bundlesA, new TeamServerClient(base, "admin-secret"));
      const ids: string[] = [];
      for (const name of ["keep-local", "go-cloud"]) {
        const p = a.profiles.create({ name, generateFingerprint: true });
        await a.lifecycle.start(p.id);
        await sync.pushProfile(p.id, "pass-phrase");
        await a.lifecycle.stop(p.id);
        ids.push(p.id);
      }

      const b = makeTestContext();
      b.settings.patch("team", { serverUrl: base, token: "admin-secret", syncPassphrase: "pass-phrase" });
      const loop = new TeamSyncLoop({
        bundles: new BundleService(b.profiles, b.lifecycle, { export: async () => [], import: async () => {} }, b.proxies),
        settings: b.settings,
        dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "qp-cloud-filter-")),
        skip: (id) => id === ids[0],
      });
      const res = await loop.tick();
      expect(res.checked).toBe(2);
      expect(res.skipped).toBe(1);
      expect(b.profiles.list().map((x) => x.name)).toEqual(["go-cloud"]);
      await a.app.close();
      await b.app.close();
    } finally {
      await server.close();
    }
  });
});
