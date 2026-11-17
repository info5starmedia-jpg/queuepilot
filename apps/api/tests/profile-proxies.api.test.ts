import { describe, expect, it, beforeEach } from "vitest";
import { makeTestContext, type TestContext } from "./helpers.js";

/**
 * v0.14.3 per-profile proxy lists — Jancy's proxies column. Operators set the
 * list via PATCH /profiles/:id/persona; GET /profiles/:id/proxies returns
 * masked parsed entries; POST /profiles/:id/proxies/rotate cycles the
 * persisted index; and a profile with no attached proxy launches through the
 * list's current entry.
 */

let ctx: TestContext;
beforeEach(() => {
  ctx = makeTestContext();
});

const LIST = {
  proxies: [
    "10.0.0.1:8080:alice:s3cret",
    "system connection",
    "socks5://10.0.0.2:1080:bob:pw2",
  ],
};

async function makeProfileWithList() {
  const p = ctx.profiles.create({ name: "pl", generateFingerprint: true });
  const res = await ctx.app.inject({
    method: "PATCH",
    url: `/profiles/${p.id}/persona`,
    payload: LIST,
  });
  expect(res.statusCode).toBe(200);
  return p;
}

describe("GET /profiles/:id/proxies", () => {
  it("lists parsed entries masked, with the current index", async () => {
    const p = await makeProfileWithList();
    const res = await ctx.app.inject({ method: "GET", url: `/profiles/${p.id}/proxies` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(3);
    expect(body.index).toBe(0);
    expect(body.entries[0]).toMatchObject({
      kind: "direct",
      scheme: "http",
      host: "10.0.0.1",
      port: 8080,
      username: "alice",
      hasPassword: true,
    });
    expect(body.entries[0]).not.toHaveProperty("password");
    expect(body.entries[1]).toMatchObject({ kind: "system" });
    expect(JSON.stringify(body)).not.toContain("s3cret");
    expect(JSON.stringify(body)).not.toContain("pw2");
  });

  it("empty list when unset", async () => {
    const p = ctx.profiles.create({ name: "none", generateFingerprint: false });
    const res = await ctx.app.inject({ method: "GET", url: `/profiles/${p.id}/proxies` });
    expect(res.json()).toEqual({ index: null, total: 0, entries: [] });
  });

  it("404s for an unknown profile", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: "/profiles/00000000-0000-4000-8000-000000000000/proxies",
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /profiles/:id/proxies/rotate", () => {
  it("cycles the persisted index with wraparound", async () => {
    const p = await makeProfileWithList();
    const first = await ctx.app.inject({ method: "POST", url: `/profiles/${p.id}/proxies/rotate` });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ index: 1, total: 3 });
    expect(first.json().current).toMatchObject({ kind: "system" });

    const second = await ctx.app.inject({ method: "POST", url: `/profiles/${p.id}/proxies/rotate` });
    expect(second.json().index).toBe(2);

    const third = await ctx.app.inject({ method: "POST", url: `/profiles/${p.id}/proxies/rotate` });
    expect(third.json().index).toBe(0);

    // Index persisted on the profile row.
    const get = await ctx.app.inject({ method: "GET", url: `/profiles/${p.id}/proxies` });
    expect(get.json().index).toBe(0);
  });

  it("409s when the list is empty", async () => {
    const p = ctx.profiles.create({ name: "empty", generateFingerprint: false });
    const res = await ctx.app.inject({ method: "POST", url: `/profiles/${p.id}/proxies/rotate` });
    expect(res.statusCode).toBe(409);
  });

  it("404s for an unknown profile", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/profiles/00000000-0000-4000-8000-000000000000/proxies/rotate",
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("proxy-list launches", () => {
  it("launches through the current list entry when no proxy is attached", async () => {
    const p = await makeProfileWithList();
    const run = await ctx.lifecycle.start(p.id);
    const snap = ctx.snapshots.forRun(run.id)!;
    expect(snap.proxySource).toBe("profile-list");
    expect(snap.proxyId).toBeNull();
    // Password never at rest in the snapshot; username kept to identify it.
    expect(snap.proxyUrl).toBe("http://alice@10.0.0.1:8080");
    // Drift explains the launch-time decision.
    expect(ctx.lifecycle.identityDrift(p.id)!.message).toContain("proxy list");
    await ctx.lifecycle.stop(p.id);
  });

  it("rotate changes what the NEXT start picks", async () => {
    const p = await makeProfileWithList();
    await ctx.app.inject({ method: "POST", url: `/profiles/${p.id}/proxies/rotate` });
    const run = await ctx.lifecycle.start(p.id);
    const snap = ctx.snapshots.forRun(run.id)!;
    // Index 1 is the system-connection entry → direct connection.
    expect(snap.proxySource).toBe("profile-list");
    expect(snap.proxyUrl).toBeNull();
    await ctx.lifecycle.stop(p.id);
  });

  it("an attached stored proxy still wins over the list", async () => {
    const stored = ctx.proxies.create({
      name: "attached",
      type: "http",
      host: "127.0.0.1",
      port: 8080,
    });
    const p = await makeProfileWithList();
    ctx.profiles.update(p.id, { proxyId: stored.id });
    const run = await ctx.lifecycle.start(p.id);
    const snap = ctx.snapshots.forRun(run.id)!;
    expect(snap.proxySource).toBe("profile");
    expect(snap.proxyUrl).toBe("http://127.0.0.1:8080");
    await ctx.lifecycle.stop(p.id);
  });

  it("a temp proxy wins over everything", async () => {
    const p = await makeProfileWithList();
    const run = await ctx.lifecycle.start(p.id, {
      tempProxy: { type: "http", host: "192.0.2.1", port: 3128 },
    });
    const snap = ctx.snapshots.forRun(run.id)!;
    expect(snap.proxySource).toBe("temporary");
    await ctx.lifecycle.stop(p.id);
  });

  it("HTTP start works end-to-end with a list in place", async () => {
    const p = await makeProfileWithList();
    const res = await ctx.app.inject({ method: "POST", url: `/profiles/${p.id}/start` });
    expect(res.statusCode).toBe(201);
    expect(ctx.snapshots.forRun(res.json().id)!.proxySource).toBe("profile-list");
    await ctx.lifecycle.stop(p.id);
  });
});
