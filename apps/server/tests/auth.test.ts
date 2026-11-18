import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { buildTeamServerApp, type TeamServerApp } from "../src/app.js";
import type { TeamServerConfig } from "../src/config.js";

/**
 * Hosted team deployment: accounts, invites, sessions, and the owner-tier
 * permission matrix (L1 run / L2 edit / L3 add+delete / owner team admin).
 */

const BOOTSTRAP_CODE = "bootstrap-code-123";
const OWNER = { email: "owner@example.com", password: "owner-password-1", displayName: "Owner" };

function config(overrides: Partial<TeamServerConfig> = {}): TeamServerConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    dbPath: ":memory:",
    adminToken: null,
    machineName: "test",
    bootstrapCode: BOOTSTRAP_CODE,
    ...overrides,
  };
}

async function listen(app: TeamServerApp["app"]): Promise<string> {
  await app.listen({ host: "127.0.0.1", port: 0 });
  const { port } = app.server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

function authed(token: string, init: RequestInit = {}): RequestInit {
  return { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) } };
}

function json(init: RequestInit, body: unknown): RequestInit {
  return {
    method: "POST",
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    body: JSON.stringify(body),
  };
}

async function bootstrapOwner(base: string): Promise<string> {
  const res = await fetch(`${base}/auth/bootstrap`, json({}, { code: BOOTSTRAP_CODE, ...OWNER }));
  expect(res.status).toBe(201);
  return ((await res.json()) as { token: string }).token;
}

async function inviteMember(
  base: string,
  ownerToken: string,
  role: "L1" | "L2" | "L3",
  email: string,
): Promise<string> {
  const mint = await fetch(
    `${base}/team/invites`,
    json(authed(ownerToken), { role }),
  );
  expect(mint.status).toBe(201);
  const { code } = (await mint.json()) as { code: string };
  const redeem = await fetch(
    `${base}/auth/redeem`,
    json({}, { code, email, password: "member-password-1", displayName: email.split("@")[0] }),
  );
  expect(redeem.status).toBe(201);
  return ((await redeem.json()) as { token: string }).token;
}

describe("hosted team auth", () => {
  let server: TeamServerApp;
  let base: string;

  beforeEach(async () => {
    server = buildTeamServerApp(config());
    base = await listen(server.app);
  });

  afterEach(async () => {
    await server.close();
  });

  it("bootstrap mints the owner once; second attempt and wrong code are refused", async () => {
    const token = await bootstrapOwner(base);
    expect(token.startsWith("qps_")).toBe(true);

    const again = await fetch(`${base}/auth/bootstrap`, json({}, { code: BOOTSTRAP_CODE, email: "x@y.z", password: "long-password-1", displayName: "X" }));
    expect(again.status).toBe(409);

    const wrong = await fetch(`${base}/auth/bootstrap`, json({}, { code: "nope", email: "x@y.z", password: "long-password-1", displayName: "X" }));
    expect(wrong.status).toBe(403);
  });

  it("bootstrap validates input (short password, bad email)", async () => {
    const short = await fetch(`${base}/auth/bootstrap`, json({}, { code: BOOTSTRAP_CODE, email: "a@b.co", password: "short", displayName: "A" }));
    expect(short.status).toBe(400);
    const badEmail = await fetch(`${base}/auth/bootstrap`, json({}, { code: BOOTSTRAP_CODE, email: "not-an-email", password: "long-password-1", displayName: "A" }));
    expect(badEmail.status).toBe(400);
  });

  it("signin returns a session; wrong password is a uniform 401; signout kills the session", async () => {
    await bootstrapOwner(base);
    const bad = await fetch(`${base}/auth/signin`, json({}, { email: OWNER.email, password: "wrong-password" }));
    expect(bad.status).toBe(401);

    const ok = await fetch(`${base}/auth/signin`, json({}, { email: OWNER.email, password: OWNER.password }));
    expect(ok.status).toBe(200);
    const { token } = (await ok.json()) as { token: string };

    const me = await fetch(`${base}/auth/me`, authed(token));
    expect(me.status).toBe(200);
    const meBody = (await me.json()) as { account: { tier: string; email: string } };
    expect(meBody.account.tier).toBe("owner");
    expect(meBody.account.email).toBe(OWNER.email);

    await fetch(`${base}/auth/signout`, authed(token, { method: "POST" }));
    expect((await fetch(`${base}/auth/me`, authed(token))).status).toBe(401);
  });

  it("invite → redeem flow; duplicate email and re-used code fail", async () => {
    const owner = await bootstrapOwner(base);
    const mint = await fetch(`${base}/team/invites`, json(authed(owner), { role: "L2" }));
    expect(mint.status).toBe(201);
    const { code } = (await mint.json()) as { code: string };
    expect(code.startsWith("qpi_")).toBe(true);

    const redeem = await fetch(`${base}/auth/redeem`, json({}, { code, email: "sam@example.com", password: "sam-password-123", displayName: "Sam" }));
    expect(redeem.status).toBe(201);
    const acct = (await redeem.json()) as { account: { tier: string } };
    expect(acct.account.tier).toBe("L2");

    const dup = await fetch(`${base}/auth/redeem`, json({}, { code, email: "other@example.com", password: "other-password-1", displayName: "Other" }));
    expect(dup.status).toBe(400); // code already consumed
  });

  it("team is capped at 10 members", async () => {
    const owner = await bootstrapOwner(base); // 1
    for (let i = 0; i < 9; i++) {
      await inviteMember(base, owner, "L1", `m${i}@example.com`);
    }
    expect((await fetch(`${base}/team/members`, authed(owner))).status).toBe(200);
    const members = (await (await fetch(`${base}/team/members`, authed(owner))).json()) as { members: unknown[]; cap: number };
    expect(members.members.length).toBe(10);
    expect(members.cap).toBe(10);

    // 11th invite must be refused at BOTH the mint and the redeem gate.
    const mint = await fetch(`${base}/team/invites`, json(authed(owner), { role: "L1" }));
    expect(mint.status).toBe(409);
  });

  it("owner manages members: role change, deactivate, delete; owner is immutable", async () => {
    const owner = await bootstrapOwner(base);
    const sam = await inviteMember(base, owner, "L1", "sam@example.com");
    const members = (await (await fetch(`${base}/team/members`, authed(owner))).json()) as { members: { id: string; tier: string }[] };
    const samId = members.members.find((m) => m.tier === "L1")!.id;

    const up = await fetch(`${base}/team/members/${samId}`, json(authed(owner, { method: "PATCH" }), { role: "L3" }));
    expect(up.status).toBe(200);

    // Owner id is immutable:
    const ownerId = members.members.find((m) => m.tier === "owner")!.id;
    expect((await fetch(`${base}/team/members/${ownerId}`, json(authed(owner, { method: "PATCH" }), { active: false }))).status).toBe(409);
    expect((await fetch(`${base}/team/members/${ownerId}`, { method: "DELETE", headers: { authorization: `Bearer ${owner}` } })).status).toBe(409);

    const del = await fetch(`${base}/team/members/${samId}`, { method: "DELETE", headers: { authorization: `Bearer ${owner}` } });
    expect(del.status).toBe(200);
    // Sam's session is gone with the account:
    expect((await fetch(`${base}/auth/me`, authed(sam))).status).toBe(401);
  });

  it("permission matrix: L1 runs but cannot write or delete; L2 edits but cannot delete; L3 adds+deletes; team routes are owner-only", async () => {
    const owner = await bootstrapOwner(base);
    const l1 = await inviteMember(base, owner, "L1", "l1@example.com");
    const l2 = await inviteMember(base, owner, "L2", "l2@example.com");
    const l3 = await inviteMember(base, owner, "L3", "l3@example.com");

    const put = (token: string, id: string, rev?: number) =>
      fetch(
        `${base}/bundles/${id}${rev !== undefined ? `?baseRevision=${rev}` : ""}`,
        authed(token, { method: "PUT", body: Buffer.from(`bundle-${id}`) }),
      );

    // L1: can run profiles (lease acquire) but no writes/deletes.
    expect((await put(l1, "p1")).status).toBe(403);
    expect((await fetch(`${base}/bundles/p1`, { method: "DELETE", headers: { authorization: `Bearer ${l1}` } })).status).toBe(403);
    const lease = await fetch(`${base}/leases/acquire`, json(authed(l1), { profileId: "p1", holder: "h" }));
    expect(lease.status).toBe(201);

    // L2: can create + edit bundles (push, then rebase) but not delete.
    expect((await put(l2, "p1")).status).toBe(200);
    expect((await put(l2, "p1", 1)).status).toBe(200);
    expect((await fetch(`${base}/bundles/p1`, { method: "DELETE", headers: { authorization: `Bearer ${l2}` } })).status).toBe(403);

    // L3: delete works.
    expect((await fetch(`${base}/bundles/p1`, { method: "DELETE", headers: { authorization: `Bearer ${l3}` } })).status).toBe(200);

    // Team management is owner-only for every non-owner tier.
    for (const token of [l1, l2, l3]) {
      expect((await fetch(`${base}/team/members`, authed(token))).status).toBe(403);
      expect((await fetch(`${base}/team/invites`, json(authed(token), { role: "L1" }))).status).toBe(403);
      expect((await fetch(`${base}/tokens`, authed(token))).status).toBe(403);
    }
  });

  it("bundle meta round-trips through list and pull", async () => {
    const owner = await bootstrapOwner(base);
    const meta = encodeURIComponent(JSON.stringify({ name: "UK Shopping #3", tags: ["uk", "shopping"] }));
    const put = await fetch(`${base}/bundles/prof-meta?meta=${meta}`, authed(owner, { method: "PUT", body: Buffer.from("bytes") }));
    expect(put.status).toBe(200);

    const list = (await (await fetch(`${base}/bundles`, authed(owner))).json()) as { bundles: { profileId: string; meta: string | null }[] };
    const head = list.bundles.find((b) => b.profileId === "prof-meta")!;
    expect(JSON.parse(head.meta!)).toEqual({ name: "UK Shopping #3", tags: ["uk", "shopping"] });

    const bad = await fetch(`${base}/bundles/prof-meta?meta=not-json`, authed(owner, { method: "PUT", body: Buffer.from("bytes2") }));
    expect(bad.status).toBe(400);
  });

  it("device tokens keep working unchanged alongside accounts", async () => {
    await bootstrapOwner(base);
    const signin = await fetch(`${base}/auth/signin`, json({}, { email: OWNER.email, password: OWNER.password }));
    const { token: owner } = (await signin.json()) as { token: string };

    // Mint a device token via the legacy route (owner can):
    const mint = await fetch(`${base}/tokens`, json(authed(owner), { name: "pc-1", role: "operator" }));
    expect(mint.status).toBe(201);
    const { token: device } = (await mint.json()) as { token: string };
    expect((await fetch(`${base}/bundles`, authed(device))).status).toBe(200);
    expect((await fetch(`${base}/leases`, authed(device))).status).toBe(200);

    // ...but a viewer device token still cannot acquire leases (legacy rule):
    const mintViewer = await fetch(`${base}/tokens`, json(authed(owner), { name: "ro-1", role: "viewer" }));
    expect(mintViewer.status).toBe(201);
    const { token: viewer } = (await mintViewer.json()) as { token: string };
    const acquire = await fetch(`${base}/leases/acquire`, json(authed(viewer), { profileId: "px", holder: "h" }));
    expect(acquire.status).toBe(403);
  });
});
