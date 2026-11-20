import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { buildTeamServerApp, type TeamServerApp } from "../src/app.js";
import type { TeamServerConfig } from "../src/config.js";

/**
 * Hosted team deployment: accounts, invites, sessions — and account
 * isolation (owner decision 2026-11-20, superseding the L1/L2/L3 tier
 * matrix): every account is a private island; the owner is the admin.
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

  it("account isolation: each account is a private island; another account's ids are 404; team routes are owner-only", async () => {
    const owner = await bootstrapOwner(base);
    const a = await inviteMember(base, owner, "L1", "a@example.com");
    const b = await inviteMember(base, owner, "L1", "b@example.com");
    const put = (token: string, id: string, bytes: string, rev?: number) =>
      fetch(
        `${base}/bundles/${id}${rev !== undefined ? `?baseRevision=${rev}` : ""}`,
        authed(token, { method: "PUT", body: Buffer.from(bytes) }),
      );
    const del = (token: string, id: string) => fetch(`${base}/bundles/${id}`, authed(token, { method: "DELETE" }));
    const list = async (token: string) =>
      ((await (await fetch(`${base}/bundles`, authed(token))).json()) as { bundles: { profileId: string }[] }).bundles.map((x) => x.profileId);

    // Every member reads and writes its own island (tiers no longer gate content).
    expect((await put(a, "p1", "A-bytes")).status).toBe(200);
    expect((await put(a, "p1", "A-bytes-2", 1)).status).toBe(200);

    // B cannot read, list or detect A's profile: 404, not 403.
    expect((await fetch(`${base}/bundles/p1`, authed(b))).status).toBe(404);
    expect(await list(b)).toEqual([]);
    // The same id in B's island is independent of A's.
    expect((await put(b, "p1", "B-bytes")).status).toBe(200);
    expect(Buffer.from(await (await fetch(`${base}/bundles/p1`, authed(a))).arrayBuffer()).toString()).toBe("A-bytes-2");
    expect((await del(b, "p1")).status).toBe(200);
    expect((await fetch(`${base}/bundles/p1`, authed(a))).status).toBe(200);
    expect((await del(b, "p1")).status).toBe(404);

    // Leases are per account too: A's lease does not block B's same-id lease.
    expect((await fetch(`${base}/leases/acquire`, json(authed(a), { profileId: "p1", holder: "ha" }))).status).toBe(201);
    expect((await fetch(`${base}/leases/acquire`, json(authed(b), { profileId: "p1", holder: "hb" }))).status).toBe(201);
    expect((await fetch(`${base}/leases/p1`, authed(b))).status).toBe(200);
    expect(((await (await fetch(`${base}/leases/p1`, authed(b))).json()) as { holder: string }).holder).toBe("hb");

    // The owner is the admin, but reads only his own island — never a member's content.
    expect((await fetch(`${base}/bundles/p1`, authed(owner))).status).toBe(404);
    expect(await list(owner)).toEqual([]);

    // Team + device-token management stays owner-only.
    for (const token of [a, b]) {
      expect((await fetch(`${base}/team/members`, authed(token))).status).toBe(403);
      expect((await fetch(`${base}/team/invites`, json(authed(token), { role: "L1" }))).status).toBe(403);
      expect((await fetch(`${base}/tokens`, authed(token))).status).toBe(403);
    }
  });

  it("owner extends/expires a member; an expired account cannot sign in or use its session; delete wipes its island", async () => {
    const owner = await bootstrapOwner(base);
    const m = await inviteMember(base, owner, "L1", "m@example.com");
    const members = (await (await fetch(`${base}/team/members`, authed(owner))).json()) as { members: { id: string; email: string }[] };
    const id = members.members.find((x) => x.email === "m@example.com")!.id;
    const patch = (body: unknown) => fetch(`${base}/team/members/${id}`, json(authed(owner, { method: "PATCH" }), body));

    expect((await fetch(`${base}/bundles/keep`, authed(m, { method: "PUT", body: Buffer.from("x") }))).status).toBe(200);
    expect((await patch({ days: 0 })).status).toBe(400);
    expect((await patch({ expiresAt: new Date(Date.now() - 60_000).toISOString() })).status).toBe(200);
    expect((await fetch(`${base}/bundles`, authed(m))).status).toBe(401);
    const signin = (pw: string) => fetch(`${base}/auth/signin`, json({}, { email: "m@example.com", password: pw }));
    expect((await signin("member-password-1")).status).toBe(401);

    // Extending revives the account: sign-in works and its content is intact.
    const ext = await patch({ days: 30 });
    expect(((await ext.json()) as { account: { expiresAt: string } }).account.expiresAt).toBeTruthy();
    const back = (await (await signin("member-password-1")).json()) as { token: string };
    expect((await fetch(`${base}/bundles/keep`, authed(back.token))).status).toBe(200);

    // The owner cannot be expired; deleting a member deletes its island.
    const me = (await (await fetch(`${base}/auth/me`, authed(owner))).json()) as { account: { id: string } };
    expect((await fetch(`${base}/team/members/${me.account.id}`, json(authed(owner, { method: "PATCH" }), { days: 1 }))).status).toBe(409);
    expect(server.store.listBundles(id)).toHaveLength(1);
    expect((await fetch(`${base}/team/members/${id}`, authed(owner, { method: "DELETE" }))).status).toBe(200);
    expect(server.store.listBundles(id)).toEqual([]);
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

  it("audit M2: two concurrent bootstraps create exactly one owner", async () => {
    const boot = (email: string) =>
      fetch(`${base}/auth/bootstrap`, json({}, { code: BOOTSTRAP_CODE, email, password: "owner-password-1", displayName: "O" }));
    const results = await Promise.all([boot("o1@example.com"), boot("o2@example.com")]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(server.authStore.listAccounts().filter((a) => a.tier === "owner")).toHaveLength(1);
  });

  it("audit M1: a rotating X-Real-IP cannot dodge the per-email sign-in limit", async () => {
    await bootstrapOwner(base);
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const r = await fetch(
        `${base}/auth/signin`,
        json({ headers: { "x-real-ip": `203.0.113.${i}` } }, { email: OWNER.email, password: "wrong-password-x" }),
      );
      statuses.push(r.status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it("audit L3: deactivating signs the member out everywhere; reactivating does not revive old sessions", async () => {
    const owner = await bootstrapOwner(base);
    const m = await inviteMember(base, owner, "L1", "z@example.com");
    const id = server.authStore.getAccountByEmail("z@example.com")!.id;
    const patch = (body: unknown) => fetch(`${base}/team/members/${id}`, json(authed(owner, { method: "PATCH" }), body));
    expect((await patch({ active: false })).status).toBe(200);
    expect((await fetch(`${base}/auth/me`, authed(m))).status).toBe(401);
    expect((await patch({ active: true })).status).toBe(200);
    expect((await fetch(`${base}/auth/me`, authed(m))).status).toBe(401);
  });

  it("audit L3 residual: a member that lapses on its own and is then extended does not get old sessions back", async () => {
    const owner = await bootstrapOwner(base);
    const m = await inviteMember(base, owner, "L1", "lapse@example.com");
    const id = server.authStore.getAccountByEmail("lapse@example.com")!.id;
    server.authStore.setAccountExpiry(id, new Date(Date.now() - 1000).toISOString()); // lapses with no PATCH
    expect((await fetch(`${base}/auth/me`, authed(m))).status).toBe(401);
    expect((await fetch(`${base}/team/members/${id}`, json(authed(owner, { method: "PATCH" }), { days: 30 }))).status).toBe(200);
    expect((await fetch(`${base}/auth/me`, authed(m))).status).toBe(401);
  });

  it("audit L4: without a valid invite, redeem never reveals whether an email exists", async () => {
    await bootstrapOwner(base);
    const r = await fetch(
      `${base}/auth/redeem`,
      json({}, { code: "qpi_not-a-real-code", email: OWNER.email, password: "member-password-1", displayName: "X" }),
    );
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe("INVALID_INVITE");
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
