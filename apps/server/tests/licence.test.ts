import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import type { AddressInfo } from "node:net";
import { buildTeamServerApp, type TeamServerApp } from "../src/app.js";
import { TeamServerStore } from "../src/store.js";

/**
 * LIC — licence keys + strict account separation. The owner (admin key)
 * issues accounts and keys but can read no content; account A can neither
 * read nor write nor even detect account B's bundles and leases.
 */

const ADMIN = "bootstrap-secret";

describe("licence keys and account separation", () => {
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
    let payload: Buffer | string | undefined;
    if (Buffer.isBuffer(body)) {
      headers["content-type"] = "application/octet-stream";
      payload = body;
    } else if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    return fetch(`${base}${p}`, { method, headers, ...(payload !== undefined ? { body: payload } : {}) });
  }

  async function account(name: string, days?: number): Promise<{ id: string; key: string }> {
    const a = await call("POST", "/accounts", ADMIN, { name, ...(days ? { days } : {}) });
    expect(a.status).toBe(201);
    const { id, invite } = (await a.json()) as { id: string; invite: string };
    expect(invite.startsWith("qpi_")).toBe(true);
    // The tester redeems the invite — no bearer; the admin never sees this key.
    const k = await call("POST", "/redeem", null, { invite, name: `${name}-pc` });
    expect(k.status).toBe(201);
    const { token } = (await k.json()) as { token: string };
    expect(token.startsWith("qpl_")).toBe(true);
    return { id, key: token };
  }

  it("admins cannot mint a key into any licensed account; a re-invite opens a wiped account", async () => {
    const a = await account("tester-1");
    await call("PUT", "/bundles/p1", a.key, Buffer.from("tester-secret"));
    await call("POST", "/leases/acquire", a.key, { profileId: "p1", holder: "T:1", ttlMs: 600_000 });
    expect((await call("POST", `/accounts/${a.id}/keys`, ADMIN, { name: "sneaky" })).status).toBe(404); // no such route
    expect((await call("POST", "/tokens", ADMIN, { name: "sneaky", role: "operator", accountId: a.id })).status).toBe(400);
    // A fresh invite is refused while the account has keys...
    expect((await call("POST", `/accounts/${a.id}/invite`, ADMIN)).status).toBe(409);
    // ...so re-entry means deleting the tester's keys first, which kills them visibly.
    const keys = (await (await call("GET", `/accounts/${a.id}/keys`, ADMIN)).json()) as { keys: { id: string }[] };
    for (const k of keys.keys) await call("DELETE", `/tokens/${k.id}`, ADMIN);
    expect((await call("GET", "/licence", a.key)).status).toBe(401);
    const re = await call("POST", `/accounts/${a.id}/invite`, ADMIN);
    expect(re.status).toBe(201);
    // Redeeming the re-invite yields an EMPTY account: the old data is gone.
    const { invite } = (await re.json()) as { invite: string };
    const k = (await (await call("POST", "/redeem", null, { invite })).json()) as { token: string };
    expect(((await (await call("GET", "/bundles", k.token)).json()) as { bundles: unknown[] }).bundles).toEqual([]);
    expect(((await (await call("GET", "/leases", k.token)).json()) as { leases: unknown[] }).leases).toEqual([]);
    expect((await call("GET", "/bundles/p1", k.token)).status).toBe(404);
  });

  it("an account holder cannot delete their last operator key", async () => {
    const a = await account("tester-5");
    const keys = (await (await call("GET", "/licence/keys", a.key)).json()) as { keys: { id: string }[] };
    const del = await call("DELETE", `/licence/keys/${keys.keys[0]!.id}`, a.key);
    expect(del.status).toBe(409);
    expect((await call("GET", "/licence", a.key)).status).toBe(200);
  });

  it("invites are single-use; an account holder adds and removes their own keys", async () => {
    const r = await call("POST", "/accounts", ADMIN, { name: "tester-2" });
    const { invite } = (await r.json()) as { invite: string };
    expect((await call("POST", "/redeem", null, { invite })).status).toBe(201);
    expect((await call("POST", "/redeem", null, { invite })).status).toBe(401);
    expect((await call("POST", "/redeem", null, { invite: "qpi_" + "x".repeat(32) })).status).toBe(401);
    expect((await call("POST", "/redeem", null, { invite: "nope" })).status).toBe(400);

    const a = await account("tester-3");
    const second = await call("POST", "/licence/keys", a.key, { name: "laptop" });
    expect(second.status).toBe(201);
    const { token, id } = (await second.json()) as { token: string; id: string };
    expect((await call("GET", "/bundles", token)).status).toBe(200);
    // Another account cannot delete it.
    const b = await account("tester-4");
    expect((await call("DELETE", `/licence/keys/${id}`, b.key)).status).toBe(404);
    expect((await call("DELETE", `/licence/keys/${id}`, a.key)).status).toBe(200);
    expect((await call("GET", "/bundles", token)).status).toBe(401);
  });

  it("refuses unauthenticated requests before reading the body", async () => {
    // In-process (a real client keeps uploading after the early 401).
    const big = Buffer.alloc(2 * 1024 * 1024, 1);
    for (const authorization of [undefined, "Bearer wrong"]) {
      const r = await server.app.inject({
        method: "PUT",
        url: "/bundles/p1",
        payload: big,
        headers: { "content-type": "application/octet-stream", ...(authorization ? { authorization } : {}) },
      });
      expect(r.statusCode).toBe(401);
    }
  });

  it("account A cannot read, write, list or detect account B's bundles", async () => {
    const a = await account("owner");
    const b = await account("tester-1");
    expect((await call("PUT", "/bundles/p1", b.key, Buffer.from("B-secret"))).status).toBe(200);

    // Same profile id in A is a separate row, not B's.
    expect((await call("GET", "/bundles/p1", a.key)).status).toBe(404);
    expect(((await (await call("GET", "/bundles", a.key)).json()) as { bundles: unknown[] }).bundles).toEqual([]);
    expect((await call("DELETE", "/bundles/p1", a.key)).status).toBe(404);
    expect((await call("PUT", "/bundles/p1", a.key, Buffer.from("A-own"))).status).toBe(200);

    const bGot = await call("GET", "/bundles/p1", b.key);
    expect(Buffer.from(await bGot.arrayBuffer()).toString()).toBe("B-secret");
    const aGot = await call("GET", "/bundles/p1", a.key);
    expect(Buffer.from(await aGot.arrayBuffer()).toString()).toBe("A-own");
  });

  it("account A cannot see or take account B's leases", async () => {
    const a = await account("owner");
    const b = await account("tester-1");
    expect((await call("POST", "/leases/acquire", b.key, { profileId: "p1", holder: "B:1", ttlMs: 600_000 })).status).toBe(201);
    expect((await call("GET", "/leases/p1", a.key)).status).toBe(404);
    expect(((await (await call("GET", "/leases", a.key)).json()) as { leases: unknown[] }).leases).toEqual([]);
    expect((await call("DELETE", "/leases/p1", a.key)).status).toBe(404);
    // A acquiring "p1" gets its own lease and does not evict B's.
    expect((await call("POST", "/leases/acquire", a.key, { profileId: "p1", holder: "A:1" })).status).toBe(201);
    expect(((await (await call("GET", "/leases/p1", b.key)).json()) as { holder: string }).holder).toBe("B:1");
  });

  it("admin keys (env and minted) read no content at all", async () => {
    const b = await account("tester-1");
    await call("PUT", "/bundles/p1", b.key, Buffer.from("B-secret"));
    const minted = (await (await call("POST", "/tokens", ADMIN, { name: "owner-admin", role: "admin" })).json()) as { token: string };
    for (const admin of [ADMIN, minted.token]) {
      for (const [m, p] of [["GET", "/bundles"], ["GET", "/bundles/p1"], ["GET", "/leases"], ["GET", "/licence"], ["DELETE", "/bundles/p1"]] as const) {
        expect((await call(m, p, admin)).status, `${m} ${p}`).toBe(403);
      }
      expect((await call("PUT", "/bundles/p9", admin, Buffer.from("x"))).status).toBe(403);
      const health = (await (await call("GET", "/health", admin)).json()) as Record<string, unknown>;
      expect(health.bundles).toBeUndefined();
    }
    // Key listings carry metadata only, never key material.
    const keys = await call("GET", `/accounts/${b.id}/keys`, ADMIN);
    expect(JSON.stringify(await keys.json())).not.toContain(b.key);
  });

  it("licence keys cannot manage accounts or keys", async () => {
    const a = await account("tester-1");
    expect((await call("GET", "/accounts", a.key)).status).toBe(403);
    expect((await call("POST", "/accounts", a.key, { name: "x" })).status).toBe(403);
    expect((await call("POST", `/accounts/${a.id}/invite`, a.key)).status).toBe(403);
    expect((await call("PATCH", `/accounts/${a.id}`, a.key, { days: 999 })).status).toBe(403);
    expect((await call("GET", "/tokens", a.key)).status).toBe(403);
  });

  it("expired licence: 401 LICENCE_EXPIRED everywhere; extending it revives the key", async () => {
    const a = await account("tester-1", 30);
    const lic = (await (await call("GET", "/licence", a.key)).json()) as { daysLeft: number; account: { name: string } };
    expect(lic.account.name).toBe("tester-1");
    expect(lic.daysLeft).toBeGreaterThanOrEqual(29);

    expect((await call("PATCH", `/accounts/${a.id}`, ADMIN, { expiresAt: new Date(Date.now() - 1000).toISOString() })).status).toBe(200);
    for (const p of ["/bundles", "/leases", "/licence"]) {
      const r = await call("GET", p, a.key);
      expect(r.status).toBe(401);
      expect(((await r.json()) as { error: { code: string } }).error.code).toBe("LICENCE_EXPIRED");
    }
    expect(await (await call("GET", "/health", a.key)).json()).toEqual({ ok: true });

    expect((await call("PATCH", `/accounts/${a.id}`, ADMIN, { days: 7 })).status).toBe(200);
    expect((await call("GET", "/bundles", a.key)).status).toBe(200);
  });

  it("revoked licence dies on the next request; delete removes the account's server data", async () => {
    const a = await account("tester-1");
    await call("PUT", "/bundles/p1", a.key, Buffer.from("x"));
    expect((await call("GET", "/bundles", a.key)).status).toBe(200);
    await call("PATCH", `/accounts/${a.id}`, ADMIN, { revoked: true });
    const r = await call("GET", "/bundles", a.key);
    expect(r.status).toBe(401);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe("LICENCE_REVOKED");

    expect((await call("DELETE", `/accounts/${a.id}`, ADMIN)).status).toBe(200);
    expect((await call("GET", "/bundles", a.key)).status).toBe(401);
    expect(server.store.listBundles(a.id)).toEqual([]);
  });

  it("viewer licence keys read but cannot write", async () => {
    const a = await account("tester-1");
    const v = (await (await call("POST", "/licence/keys", a.key, { name: "ro", role: "viewer" })).json()) as { token: string };
    expect((await call("POST", "/licence/keys", v.token, { name: "x" })).status).toBe(403);
    expect((await call("GET", "/bundles", v.token)).status).toBe(200);
    expect((await call("PUT", "/bundles/p1", v.token, Buffer.from("x"))).status).toBe(403);
    expect((await call("POST", "/leases/acquire", v.token, { profileId: "p1", holder: "V:1" })).status).toBe(403);
  });

  it("validates account input", async () => {
    expect((await call("POST", "/accounts", ADMIN, { name: "" })).status).toBe(400);
    expect((await call("POST", "/accounts", ADMIN, { name: "x", days: 0 })).status).toBe(400);
    expect((await call("POST", "/accounts", ADMIN, { name: "x", expiresAt: "not a date" })).status).toBe(400);
    expect((await call("PATCH", "/accounts/acct_nope", ADMIN, { days: 3 })).status).toBe(404);
    expect((await call("POST", "/accounts/acct_nope/invite", ADMIN)).status).toBe(404);
    expect((await call("POST", "/tokens", ADMIN, { name: "k", role: "operator", accountId: "acct_nope" })).status).toBe(400);
    expect((await call("POST", "/tokens", ADMIN, { name: "k", role: "admin", accountId: "team" })).status).toBe(400);
  });
});

describe("pre-licence database migration", () => {
  it("moves old bundles, leases and non-admin tokens into the team account; admin stays account-less", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qp-lic-"));
    const file = path.join(dir, "team.db");
    const old = new Database(file);
    old.exec(`
      CREATE TABLE bundles (profile_id TEXT PRIMARY KEY, payload TEXT NOT NULL, revision INTEGER NOT NULL, updated_by TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE tokens (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, role TEXT NOT NULL CHECK (role IN ('admin','operator','viewer')), created_at TEXT NOT NULL, last_used_at TEXT);
      CREATE TABLE leases (profile_id TEXT PRIMARY KEY, holder TEXT NOT NULL, machine TEXT NOT NULL, acquired_at TEXT NOT NULL, expires_at TEXT NOT NULL);
    `);
    const now = new Date().toISOString();
    old.prepare("INSERT INTO bundles VALUES (?,?,?,?,?)").run("p1", Buffer.from("sealed").toString("base64"), 3, "pc", now);
    old.prepare("INSERT INTO tokens VALUES (?,?,?,?,?,?)").run("t1", "desk", TeamServerStore.hashToken("op-key"), "operator", now, null);
    old.prepare("INSERT INTO tokens VALUES (?,?,?,?,?,?)").run("t2", "boss", TeamServerStore.hashToken("admin-key"), "admin", now, null);
    old.prepare("INSERT INTO leases VALUES (?,?,?,?,?)").run("p1", "pc:1", "pc", now, new Date(Date.now() + 60_000).toISOString());
    old.close();

    const store = new TeamServerStore(file);
    expect(store.authenticate("op-key")).toMatchObject({ ok: true, role: "operator", accountId: "team" });
    expect(store.authenticate("admin-key")).toMatchObject({ ok: true, role: "admin", accountId: null });
    expect(store.listBundles("team").map((b) => [b.profileId, b.revision])).toEqual([["p1", 3]]);
    expect(store.getLease("team", "p1")?.holder).toBe("pc:1");
    store.close();
    // Re-opening a migrated database is a no-op.
    const again = new TeamServerStore(file);
    expect(again.listBundles("team")).toHaveLength(1);
    again.close();
  });
});
