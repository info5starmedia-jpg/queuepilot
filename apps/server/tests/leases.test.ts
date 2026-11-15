import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { buildTeamServerApp, type TeamServerApp } from "@queuepilot/server";

/**
 * P7.7b — launch leases on the team server: the cross-machine double-start
 * guard. Acquire/renew/release/TTL takeover, role gating, and the LEASE_HELD
 * contract a machine sees when another holder has the profile.
 */

describe("team server leases", () => {
  let server: TeamServerApp;
  let base: string;
  let token: string;

  beforeEach(async () => {
    server = buildTeamServerApp({
      host: "127.0.0.1",
      port: 0,
      dbPath: ":memory:",
      adminToken: "bootstrap-secret",
      machineName: "test",
    });
    await server.app.listen({ host: "127.0.0.1", port: 0 });
    const { port } = server.app.server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
    token = "bootstrap-secret";
  });

  afterEach(async () => {
    await server.close();
  });

  async function rpc(
    method: string,
    path: string,
    body?: unknown,
    useToken: string | null = token,
  ): Promise<Response> {
    const headers: Record<string, string> = {};
    if (useToken) headers.authorization = `Bearer ${useToken}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const init: RequestInit = { method, headers };
    if (body !== undefined) init.body = JSON.stringify(body);
    return fetch(`${base}${path}`, init);
  }

  it("acquire → second holder gets 409 LEASE_HELD → release → acquire succeeds", async () => {
    const first = await rpc("POST", "/leases/acquire", {
      profileId: "p1",
      holder: "machineA:100",
      machine: "machineA",
    });
    expect(first.status).toBe(201);

    const second = await rpc("POST", "/leases/acquire", {
      profileId: "p1",
      holder: "machineB:200",
      machine: "machineB",
    });
    expect(second.status).toBe(409);
    const err = (await second.json()) as { error: { code: string; heldBy: string } };
    expect(err.error.code).toBe("LEASE_HELD");
    expect(err.error.heldBy).toBe("machineA:100");

    const release = await rpc("POST", "/leases/release", {
      profileId: "p1",
      holder: "machineA:100",
    });
    expect(await release.json()).toEqual({ released: true });

    const third = await rpc("POST", "/leases/acquire", {
      profileId: "p1",
      holder: "machineB:200",
      machine: "machineB",
    });
    expect(third.status).toBe(201);
  });

  it("same holder may re-acquire (idempotent renewal of ownership)", async () => {
    await rpc("POST", "/leases/acquire", { profileId: "p2", holder: "A:1" });
    const again = await rpc("POST", "/leases/acquire", { profileId: "p2", holder: "A:1" });
    expect(again.status).toBe(201);
  });

  it("expired lease is taken over unconditionally (crashed-holder cleanup)", async () => {
    await rpc("POST", "/leases/acquire", {
      profileId: "p3",
      holder: "dead:1",
      ttlMs: 5_000,
    });
    // Rewind the expiry to the past directly in the store — no public API
    // for time travel.
    const db = (server.store as unknown as {
      db: { prepare: (s: string) => { run: (...a: unknown[]) => unknown } };
    }).db;
    db.prepare("UPDATE leases SET expires_at = ? WHERE profile_id = ?").run(
      new Date(Date.now() - 1_000).toISOString(),
      "p3",
    );
    const takeover = await rpc("POST", "/leases/acquire", { profileId: "p3", holder: "live:2" });
    expect(takeover.status).toBe(201);
  });

  it("renew extends the same holder's lease; a stranger's renew is 409", async () => {
    const acquired = (await (
      await rpc("POST", "/leases/acquire", { profileId: "p4", holder: "A:9", ttlMs: 10_000 })
    ).json()) as { expiresAt: string };
    const renewed = await rpc("POST", "/leases/renew", { profileId: "p4", holder: "A:9", ttlMs: 20_000 });
    expect(renewed.status).toBe(200);
    const body = (await renewed.json()) as { expiresAt: string };
    expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.parse(acquired.expiresAt));

    const stranger = await rpc("POST", "/leases/renew", { profileId: "p4", holder: "B:9" });
    expect(stranger.status).toBe(409);
    expect(((await stranger.json()) as { error: { code: string } }).error.code).toBe("LEASE_LOST");
  });

  it("a stranger's release is a no-op (false -> lease survives)", async () => {
    await rpc("POST", "/leases/acquire", { profileId: "p5", holder: "A:1" });
    const res = await rpc("POST", "/leases/release", { profileId: "p5", holder: "B:1" });
    expect(await res.json()).toEqual({ released: false });
    const lease = await rpc("GET", "/leases/p5");
    expect(lease.status).toBe(200);
  });

  it("list/get expose live leases; unknown profile is 404", async () => {
    await rpc("POST", "/leases/acquire", { profileId: "p6", holder: "A:1" });
    const list = (await (await rpc("GET", "/leases")).json()) as { leases: { profileId: string }[] };
    expect(list.leases.map((l: { profileId: string }) => l.profileId)).toContain("p6");
    const one = (await (await rpc("GET", "/leases/p6")).json()) as { holder: string };
    expect(one.holder).toBe("A:1");
    const none = await rpc("GET", "/leases/ghost");
    expect(none.status).toBe(404);
  });

  it("viewer tokens cannot acquire (403); unauthenticated is 401", async () => {
    const minted = (await (
      await rpc("POST", "/tokens", { name: "looker", role: "viewer" })
    ).json()) as { token: string };
    const denied = await rpc(
      "POST",
      "/leases/acquire",
      { profileId: "p7", holder: "V:1" },
      minted.token,
    );
    expect(denied.status).toBe(403);
    const anon = await rpc("POST", "/leases/acquire", { profileId: "p7", holder: "X:1" }, null);
    expect(anon.status).toBe(401);
  });

  it("rejects malformed bodies with 400", async () => {
    const res = await rpc("POST", "/leases/acquire", { profileId: "bad id!", holder: "A:1" });
    expect(res.status).toBe(400);
  });
});
