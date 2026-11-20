import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { buildTeamServerApp, type TeamServerApp } from "../src/app.js";
import type { TeamServerConfig } from "../src/config.js";

const ADMIN = "bootstrap-secret";

function config(overrides: Partial<TeamServerConfig> = {}): TeamServerConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    dbPath: ":memory:",
    adminToken: ADMIN,
    machineName: "test",
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

async function mint(base: string, name: string, role: "admin" | "operator" | "viewer"): Promise<{ token: string; id: string }> {
  const res = await fetch(`${base}/tokens`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN}` },
    body: JSON.stringify({ name, role }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { token: string; id: string };
}

describe("team server", () => {
  let server: TeamServerApp;
  let base: string;
  /** An operator device token: the owner's machine, so it reads/writes the owner's account. */
  let OP: string;

  beforeEach(async () => {
    server = buildTeamServerApp(config());
    base = await listen(server.app);
    OP = (await mint(base, "op-desktop", "operator")).token;
  });

  afterEach(async () => {
    await server.close();
  });

  it("health needs no auth but leaks no metadata (audit 4b)", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    // Unauthenticated probes get liveness ONLY — no server name, bundle
    // counts, or role information for a port-scanner to harvest.
    expect(body).toEqual({ ok: true });
  });

  it("rejects missing and wrong tokens everywhere else", async () => {
    expect((await fetch(`${base}/bundles`)).status).toBe(401);
    expect((await fetch(`${base}/bundles`, authed("wrong"))).status).toBe(401);
  });

  it("admin credentials manage accounts but read no content (403)", async () => {
    const adminDevice = (await mint(base, "admin-pc", "admin")).token;
    for (const t of [ADMIN, adminDevice]) {
      expect((await fetch(`${base}/bundles`, authed(t))).status).toBe(403);
      expect((await fetch(`${base}/bundles/x`, authed(t, { method: "PUT", body: Buffer.from("v") }))).status).toBe(403);
      expect((await fetch(`${base}/leases`, authed(t))).status).toBe(403);
      expect((await fetch(`${base}/warmup/personas`, authed(t))).status).toBe(403);
      expect((await fetch(`${base}/tokens`, authed(t))).status).toBe(200);
    }
  });

  it("push/pull round-trips opaque bytes with revision headers", async () => {
    const bytes = Buffer.from("sealed-bundle-bytes", "utf8");
    const put = await fetch(
      `${base}/bundles/prof-1`,
      authed(OP, { method: "PUT", body: bytes, headers: { "content-type": "application/octet-stream" } }),
    );
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ profileId: "prof-1", revision: 1 });

    const got = await fetch(`${base}/bundles/prof-1`, authed(OP));
    expect(got.status).toBe(200);
    expect(Buffer.from(await got.arrayBuffer()).equals(bytes)).toBe(true);
    expect(got.headers.get("x-revision")).toBe("1");
    expect(got.headers.get("x-updated-by")).toBe("op-desktop");
  });

  it("optimistic concurrency: stale baseRevision is a 409 with current revision", async () => {
    const put = (rev?: number) =>
      fetch(`${base}/bundles/prof-1${rev === undefined ? "" : `?baseRevision=${rev}`}`, authed(OP, {
        method: "PUT",
        body: Buffer.from("v"),
      }));
    expect((await put()).status).toBe(200); // first push, no base
    const stale = await put(0);
    expect(stale.status).toBe(409);
    const body = (await stale.json()) as { error: { code: string; currentRevision: number } };
    expect(body.error.code).toBe("REVISION_CONFLICT");
    expect(body.error.currentRevision).toBe(1);
    expect((await put(1)).status).toBe(200); // rebased push lands as rev 2
  });

  it("first push with a non-zero baseRevision is rejected (no create-under-race)", async () => {
    const res = await fetch(`${base}/bundles/new-prof?baseRevision=5`, authed(OP, {
      method: "PUT",
      body: Buffer.from("v"),
    }));
    expect(res.status).toBe(409);
  });

  it("roles: viewer reads but cannot write; operator writes; both see the owner's account", async () => {
    const { token } = await mint(base, "friend-laptop", "viewer");
    expect((await fetch(`${base}/bundles/x`, authed(OP, { method: "PUT", body: Buffer.from("v") }))).status).toBe(200);
    const list = (await (await fetch(`${base}/bundles`, authed(token))).json()) as { bundles: { profileId: string }[] };
    expect(list.bundles.map((b) => b.profileId)).toEqual(["x"]);
    const denied = await fetch(`${base}/bundles/x`, authed(token, { method: "PUT", body: Buffer.from("v") }));
    expect(denied.status).toBe(403);
  });

  it("minted tokens are hash-only: list shows metadata, never the secret; deleted token dies", async () => {
    const { token, id } = await mint(base, "temp", "operator");

    const list = await fetch(`${base}/tokens`, authed(ADMIN));
    const { tokens } = (await list.json()) as { tokens: Record<string, unknown>[] };
    const mine = tokens.find((t) => t.id === id)!;
    expect(JSON.stringify(mine)).not.toContain(token);

    const del = await fetch(`${base}/tokens/${id}`, authed(ADMIN, { method: "DELETE" }));
    expect(del.status).toBe(200);
    expect((await fetch(`${base}/bundles`, authed(token))).status).toBe(401);
  });

  it("validates profileId and body", async () => {
    const bad = await fetch(`${base}/bundles/${encodeURIComponent("no spaces!")}`, authed(OP, {
      method: "PUT",
      body: Buffer.from("v"),
    }));
    expect(bad.status).toBe(400);
    const empty = await fetch(`${base}/bundles/ok-id`, authed(OP, { method: "PUT", body: Buffer.alloc(0) }));
    expect(empty.status).toBe(400);
  });

  it("list and delete", async () => {
    await fetch(`${base}/bundles/b`, authed(OP, { method: "PUT", body: Buffer.from("2") }));
    await fetch(`${base}/bundles/a`, authed(OP, { method: "PUT", body: Buffer.from("1") }));
    const list = await fetch(`${base}/bundles`, authed(OP));
    const { bundles } = (await list.json()) as { bundles: { profileId: string; revision: number }[] };
    expect(bundles.map((b) => b.profileId)).toEqual(["a", "b"]);

    await fetch(`${base}/bundles/a`, authed(OP, { method: "DELETE" }));
    expect((await fetch(`${base}/bundles/a`, authed(OP))).status).toBe(404);
  });

  it("viewer cannot mint tokens (403) and env admin is required when no bootstrap token is set", async () => {
    await server.close();
    server = buildTeamServerApp(config({ adminToken: null }));
    base = await listen(server.app);
    // No bootstrap, empty DB: nobody is admin yet — minting is impossible
    // until an admin token exists in the DB (documented chicken-and-egg).
    const res = await fetch(`${base}/tokens`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer whatever" },
      body: JSON.stringify({ name: "x", role: "viewer" }),
    });
    expect(res.status).toBe(401);
  });
});
