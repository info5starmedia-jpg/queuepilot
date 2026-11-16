import { describe, expect, it } from "vitest";
import { makeTestContext } from "./helpers.js";

/**
 * Dashboard batch state (v0.15.1, audit B4): one request carries drift +
 * tab count for every running profile on the grid. The per-profile /drift +
 * /tabs pair it replaces was 2N requests per grid refresh — the N+1 that
 * fell over past a few dozen running profiles.
 */

describe("POST /profiles/batch-state", () => {
  it("returns drift + tab count for many profiles in one call", async () => {
    const ctx = makeTestContext();
    const a = ctx.profiles.create({ name: "a", generateFingerprint: true });
    const b = ctx.profiles.create({ name: "b", generateFingerprint: true });

    await ctx.app.inject({ method: "POST", url: `/profiles/${a.id}/start`, payload: {} });
    await ctx.app.inject({ method: "POST", url: `/profiles/${b.id}/start`, payload: {} });
    await ctx.app.inject({
      method: "POST",
      url: `/profiles/${a.id}/tabs`,
      payload: { url: "https://example.com" },
    });

    const res = await ctx.app.inject({
      method: "POST",
      url: "/profiles/batch-state",
      payload: { ids: [a.id, b.id] },
    });
    expect(res.statusCode).toBe(200);
    const { states } = res.json();
    expect(states).toHaveLength(2);
    const byId = new Map(states.map((s: { id: string }) => [s.id, s]));
    expect(byId.get(a.id).tabCount).toBe(1);
    expect(byId.get(b.id).tabCount).toBe(0);
    // Fresh launches: nothing stale yet.
    expect(byId.get(a.id).drift?.stale ?? false).toBe(false);
  });

  it("reports stale drift after an identity change while running", async () => {
    const ctx = makeTestContext();
    const a = ctx.profiles.create({ name: "drift", generateFingerprint: true });
    await ctx.app.inject({ method: "POST", url: `/profiles/${a.id}/start`, payload: {} });
    await ctx.app.inject({ method: "POST", url: `/profiles/${a.id}/fingerprint/regenerate`, payload: {} });

    const res = await ctx.app.inject({
      method: "POST",
      url: "/profiles/batch-state",
      payload: { ids: [a.id] },
    });
    const state = res.json().states[0];
    expect(state.drift.stale).toBe(true);
  });

  it("isolates bad ids — one unknown profile never fails the batch", async () => {
    const ctx = makeTestContext();
    const a = ctx.profiles.create({ name: "ok", generateFingerprint: true });
    await ctx.app.inject({ method: "POST", url: `/profiles/${a.id}/start`, payload: {} });

    const res = await ctx.app.inject({
      method: "POST",
      url: "/profiles/batch-state",
      payload: { ids: [a.id, "99999999-9999-4999-8999-999999999999"] },
    });
    expect(res.statusCode).toBe(200);
    const { states } = res.json();
    expect(states).toHaveLength(2);
    const ok = states.find((s: { id: string }) => s.id === a.id);
    const bad = states.find((s: { id: string }) => s.id !== a.id);
    expect(ok.tabCount).toBe(0);
    expect(bad.drift).toBeNull();
    expect(bad.tabCount).toBe(0);
  });

  it("validates the body", async () => {
    const ctx = makeTestContext();
    const empty = await ctx.app.inject({ method: "POST", url: "/profiles/batch-state", payload: { ids: [] } });
    expect(empty.statusCode).toBe(400);
    const notUuid = await ctx.app.inject({
      method: "POST",
      url: "/profiles/batch-state",
      payload: { ids: ["nope"] },
    });
    expect(notUuid.statusCode).toBe(400);
  });
});
