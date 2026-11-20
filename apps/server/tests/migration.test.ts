import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { buildTeamServerApp, type TeamServerApp } from "../src/app.js";
import { AuthStore } from "../src/auth-store.js";
import { TeamServerStore } from "../src/store.js";

/**
 * Account-isolation migration (owner decision 2026-11-20). A database shaped
 * like the live hosted server before this change — owner account + sessions,
 * bundles/leases keyed by profile_id alone, device tokens without an account —
 * must upgrade so the owner's existing data lands in HIS account and his
 * existing sign-in keeps working. Admin tokens stay account-less.
 */

const OWNER = { email: "owner@example.com", password: "owner-password-1", displayName: "Owner" };
const ADMIN_DEVICE = "qpt_admin_legacy_token";
const OP_DEVICE = "qpt_operator_legacy_token";

let dir: string;
let server: TeamServerApp | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

/** Old (pre-isolation) content tables, exactly as main's store created them. */
function seedLegacyContent(db: Database.Database): void {
  db.exec(`
    CREATE TABLE bundles (profile_id TEXT PRIMARY KEY, payload TEXT NOT NULL, revision INTEGER NOT NULL,
      updated_by TEXT NOT NULL, updated_at TEXT NOT NULL, meta TEXT);
    CREATE TABLE tokens (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL CHECK (role IN ('admin','operator','viewer')), created_at TEXT NOT NULL, last_used_at TEXT);
    CREATE TABLE leases (profile_id TEXT PRIMARY KEY, holder TEXT NOT NULL, machine TEXT NOT NULL,
      acquired_at TEXT NOT NULL, expires_at TEXT NOT NULL);
  `);
  const now = new Date().toISOString();
  const later = new Date(Date.now() + 600_000).toISOString();
  db.prepare("INSERT INTO bundles VALUES (?,?,?,?,?,?)").run("live-prof", Buffer.from("owner-bytes").toString("base64"), 3, "pc", now, '{"name":"Live"}');
  db.prepare("INSERT INTO leases VALUES (?,?,?,?,?)").run("live-prof", "pc:1", "pc", now, later);
  db.prepare("INSERT INTO tokens VALUES (?,?,?,?,?,?)").run("t-admin", "admin-pc", TeamServerStore.hashToken(ADMIN_DEVICE), "admin", now, null);
  db.prepare("INSERT INTO tokens VALUES (?,?,?,?,?,?)").run("t-op", "desk", TeamServerStore.hashToken(OP_DEVICE), "operator", now, null);
}

async function open(dbPath: string, extra: { bootstrapCode?: string } = {}): Promise<string> {
  server = buildTeamServerApp({ host: "127.0.0.1", port: 0, dbPath, adminToken: null, machineName: "t", ...extra });
  await server.app.listen({ host: "127.0.0.1", port: 0 });
  return `http://127.0.0.1:${(server.app.server.address() as AddressInfo).port}`;
}

const authed = (t: string, init: RequestInit = {}): RequestInit => ({ ...init, headers: { authorization: `Bearer ${t}`, ...(init.headers ?? {}) } });
const post = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("account-isolation migration", () => {
  it("a live hosted DB upgrades: the owner's data lands in his account and his sign-in keeps working", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "qp-team-mig-"));
    const dbPath = path.join(dir, "team.db");
    const db = new Database(dbPath);
    const auth = new AuthStore(db); // the live owner account, as the hosted deploy created it
    const owner = await auth.createAccount(OWNER.email, OWNER.password, OWNER.displayName, "owner");
    const member = await auth.createAccount("kid@example.com", "member-password-1", "Kid", "L2");
    const { token: oldSession } = auth.createSession(owner.id);
    seedLegacyContent(db);
    db.close();

    const base = await open(dbPath);

    // The session issued before the update still works, and sees the owner's bundle.
    const before = (await (await fetch(`${base}/bundles`, authed(oldSession))).json()) as { bundles: { profileId: string; revision: number; meta: string }[] };
    expect(before.bundles).toEqual([expect.objectContaining({ profileId: "live-prof", revision: 3, meta: '{"name":"Live"}' })]);

    // A fresh sign-in with the existing password works too.
    const signin = await fetch(`${base}/auth/signin`, post({ email: OWNER.email, password: OWNER.password }));
    expect(signin.status).toBe(200);
    const { token } = (await signin.json()) as { token: string };
    expect(Buffer.from(await (await fetch(`${base}/bundles/live-prof`, authed(token))).arrayBuffer()).toString()).toBe("owner-bytes");
    expect(((await (await fetch(`${base}/leases/live-prof`, authed(token))).json()) as { holder: string }).holder).toBe("pc:1");

    // The owner's old desktop token is in his account; the admin token stays account-less.
    expect((await fetch(`${base}/bundles/live-prof`, authed(OP_DEVICE))).status).toBe(200);
    expect((await fetch(`${base}/bundles`, authed(ADMIN_DEVICE))).status).toBe(403);
    expect((await fetch(`${base}/team/members`, authed(ADMIN_DEVICE))).status).toBe(200);

    // An existing member now has a private, empty island — never the owner's data.
    const kid = (await (await fetch(`${base}/auth/signin`, post({ email: "kid@example.com", password: "member-password-1" }))).json()) as { token: string };
    expect((await fetch(`${base}/bundles/live-prof`, authed(kid.token))).status).toBe(404);
    expect(server!.store.listBundles(member.id)).toEqual([]);

    // Re-opening the upgraded DB is a no-op (idempotent).
    await server!.close();
    server = null;
    const base2 = await open(dbPath);
    expect(((await (await fetch(`${base2}/bundles`, authed(token))).json()) as { bundles: unknown[] }).bundles).toHaveLength(1);
  });

  it("a pre-owner DB parks content until the owner bootstraps, then the owner adopts it", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "qp-team-mig-"));
    const dbPath = path.join(dir, "team.db");
    const db = new Database(dbPath);
    seedLegacyContent(db);
    db.close();

    const base = await open(dbPath, { bootstrapCode: "boot-code-1" });
    // Before any owner exists, the old desktop token keeps working on its content.
    expect((await fetch(`${base}/bundles/live-prof`, authed(OP_DEVICE))).status).toBe(200);

    const boot = await fetch(`${base}/auth/bootstrap`, post({ code: "boot-code-1", ...OWNER }));
    expect(boot.status).toBe(201);
    const { token } = (await boot.json()) as { token: string };
    expect((await fetch(`${base}/bundles/live-prof`, authed(token))).status).toBe(200);
    expect((await fetch(`${base}/bundles/live-prof`, authed(OP_DEVICE))).status).toBe(200);
  });

  it("audit L2: parked content self-heals into the owner's account on the next start", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "qp-team-mig-"));
    const dbPath = path.join(dir, "team.db");
    const db = new Database(dbPath);
    seedLegacyContent(db);
    new TeamServerStore(db); // migrates with no owner → content parked under owner-pending
    const owner = await new AuthStore(db).createAccount(OWNER.email, OWNER.password, OWNER.displayName, "owner"); // owner made outside bootstrap
    db.close();

    const base = await open(dbPath);
    expect(server!.store.listBundles(owner.id).map((b) => b.profileId)).toEqual(["live-prof"]);
    const { token } = (await (await fetch(`${base}/auth/signin`, post({ email: OWNER.email, password: OWNER.password }))).json()) as { token: string };
    expect((await fetch(`${base}/bundles/live-prof`, authed(token))).status).toBe(200);
  });
});
