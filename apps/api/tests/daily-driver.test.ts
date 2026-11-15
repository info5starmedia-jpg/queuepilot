import { describe, expect, it } from "vitest";
import { makeTestContext } from "./helpers.js";

/** v0.14.19 daily-driver batch: clone, batch-stop, and the search filter. */

describe("POST /profiles/:id/clone", () => {
  it("copies persona, group, proxy and notes but issues a fresh identity", async () => {
    const ctx = makeTestContext();
    const src = ctx.profiles.create({
      name: "clone-src",
      group: "work",
      email: "src@example.com",
      notes: "primary account",
      tags: ["vip"],
      generateFingerprint: true,
    });
    ctx.profiles.updatePersona(src.id, { favorite: true, tabColor: "#e91e63" });

    const res = await ctx.app.inject({
      method: "POST",
      url: `/profiles/${src.id}/clone`,
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    const copy = res.json();
    expect(copy.id).not.toBe(src.id);
    expect(copy.name).toBe("clone-src copy");
    expect(copy.group).toBe("work");
    expect(copy.email).toBe("src@example.com");
    expect(copy.notes).toBe("primary account");
    expect(copy.tags).toEqual(["vip"]);
    expect(copy.status).toBe("idle");
    // Fresh fingerprint — a shared identityId would be a linkage.
    expect(copy.identityId).not.toBe(src.identityId);
    expect(copy.identityId).toBeTruthy();
    // Persona bag travels…
    expect(copy.extra.favorite).toBe(true);
    expect(copy.extra.tabColor).toBe("#e91e63");
    // …but provider linkage must not (upsert keys stay 1:1 with the source row).
    expect(copy.providerId).toBeNull();
    expect(copy.providerKey).toBeNull();
  });

  it("honors an explicit name", async () => {
    const ctx = makeTestContext();
    const src = ctx.profiles.create({ name: "orig", generateFingerprint: true });
    const res = await ctx.app.inject({
      method: "POST",
      url: `/profiles/${src.id}/clone`,
      payload: { name: "my second" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().name).toBe("my second");
  });

  it("404s on an unknown source profile", async () => {
    const ctx = makeTestContext();
    const res = await ctx.app.inject({
      method: "POST",
      url: "/profiles/nope/clone",
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /profiles/batch-stop", () => {
  it("stops every running profile and reports per-profile rows", async () => {
    const ctx = makeTestContext();
    const a = ctx.profiles.create({ name: "stop-a", generateFingerprint: true });
    const b = ctx.profiles.create({ name: "stop-b", generateFingerprint: true });
    await ctx.lifecycle.start(a.id, {});
    await ctx.lifecycle.start(b.id, {});

    const res = await ctx.app.inject({
      method: "POST",
      url: "/profiles/batch-stop",
      payload: { ids: [a.id, b.id] },
    });
    expect(res.statusCode).toBe(200);
    const { results } = res.json();
    expect(results).toHaveLength(2);
    expect(results.every((r: { status: string }) => r.status === "stopped")).toBe(true);
    expect(ctx.profiles.get(a.id).status).toBe("idle");
    expect(ctx.profiles.get(b.id).status).toBe("idle");
  });

  it("an already-idle profile still counts as stopped (idempotent)", async () => {
    const ctx = makeTestContext();
    const idle = ctx.profiles.create({ name: "stop-idle", generateFingerprint: true });
    const res = await ctx.app.inject({
      method: "POST",
      url: "/profiles/batch-stop",
      payload: { ids: [idle.id] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().results[0]).toMatchObject({ id: idle.id, status: "stopped" });
  });

  it("one unknown id fails its row and never aborts the batch", async () => {
    const ctx = makeTestContext();
    const running = ctx.profiles.create({ name: "stop-ok", generateFingerprint: true });
    await ctx.lifecycle.start(running.id, {});
    const res = await ctx.app.inject({
      method: "POST",
      url: "/profiles/batch-stop",
      payload: { ids: ["ghost", running.id] },
    });
    expect(res.statusCode).toBe(200);
    const { results } = res.json();
    expect(results[0]).toMatchObject({ id: "ghost", status: "failed" });
    expect(results[0].error.code).toBe("PROFILE_NOT_FOUND");
    expect(results[1]).toMatchObject({ id: running.id, status: "stopped" });
    expect(ctx.profiles.get(running.id).status).toBe("idle");
  });

  it("rejects bad input with 400", async () => {
    const ctx = makeTestContext();
    const res = await ctx.app.inject({
      method: "POST",
      url: "/profiles/batch-stop",
      payload: { ids: [] },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /profiles?query= (server-side search backing the console box)", () => {
  it("filters by name substring, case-insensitive", async () => {
    const ctx = makeTestContext();
    ctx.profiles.create({ name: "Shopper One", generateFingerprint: true });
    ctx.profiles.create({ name: "Mail Box", generateFingerprint: true });
    const res = await ctx.app.inject({ method: "GET", url: "/profiles?query=shop" });
    expect(res.statusCode).toBe(200);
    const names = res.json().profiles.map((p: { name: string }) => p.name);
    expect(names).toEqual(["Shopper One"]);
  });
});

describe("profile panel contract (v0.14.20)", () => {
  it("GET /profiles/:id exposes every persona field the panel edits", async () => {
    const ctx = makeTestContext();
    const p = ctx.profiles.create({ name: "panel", generateFingerprint: true });
    await ctx.app.inject({
      method: "PATCH",
      url: `/profiles/${p.id}/persona`,
      payload: {
        phone: "+1 416 555 0100",
        dob: "1990-04-12",
        smsNumbers: [{ number: "+1 416 555 0199" }],
        startUrls: ["https://example.com"],
        tabColor: "#ff8800",
        favorite: true,
        address: { line1: "100 Queen St W", city: "Toronto" },
      },
    });
    const res = await ctx.app.inject({ method: "GET", url: `/profiles/${p.id}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.extra.phone).toBe("+1 416 555 0100");
    expect(body.extra.dob).toBe("1990-04-12");
    expect(body.extra.smsNumbers).toEqual([
      { label: "", number: "+1 416 555 0199", countryCode: null },
    ]);
    expect(body.extra.startUrls).toEqual(["https://example.com"]);
    expect(body.extra.tabColor).toBe("#ff8800");
    expect(body.extra.favorite).toBe(true);
    expect(body.extra.address.line1).toBe("100 Queen St W");
    expect(body.extra.address.city).toBe("Toronto");
  });

  it("PATCH /profiles/:id clears email and proxy with null in one call", async () => {
    const ctx = makeTestContext();
    const proxy = ctx.proxies.create({
      name: "panel-proxy",
      type: "http",
      host: "127.0.0.1",
      port: 8080,
      username: null,
      password: null,
    });
    const p = ctx.profiles.create({
      name: "panel-clear",
      email: "old@example.com",
      proxyId: proxy.id,
      generateFingerprint: true,
    });
    const res = await ctx.app.inject({
      method: "PATCH",
      url: `/profiles/${p.id}`,
      payload: { email: null, proxyId: null },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.email).toBeNull();
    expect(body.proxyId).toBeNull();
    expect(ctx.profiles.get(p.id).email).toBeNull();
    expect(ctx.profiles.get(p.id).proxyId).toBeNull();
  });
});
