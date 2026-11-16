import { describe, expect, it } from "vitest";
import { makeTestContext } from "./helpers.js";

/**
 * Warmup recorder + player (P3, v0.16.0): record a live profile's URL visit
 * sequence with real dwell times, replay it later for cookie warming.
 */

describe("warmup recipes", () => {
  it("create → list → get → delete round-trips", async () => {
    const ctx = makeTestContext();
    const created = await ctx.app.inject({
      method: "POST",
      url: "/warmups",
      payload: { name: "morning", steps: [{ url: "https://example.com", dwellMs: 5000 }] },
    });
    expect(created.statusCode).toBe(201);
    const recipe = created.json();

    const listed = await ctx.app.inject({ method: "GET", url: "/warmups" });
    expect(listed.json().recipes).toHaveLength(1);

    const got = await ctx.app.inject({ method: "GET", url: `/warmups/${recipe.id}` });
    expect(got.statusCode).toBe(200);
    expect(got.json().steps).toEqual([{ url: "https://example.com", dwellMs: 5000 }]);

    const del = await ctx.app.inject({ method: "DELETE", url: `/warmups/${recipe.id}` });
    expect(del.statusCode).toBe(204);
    const after = await ctx.app.inject({ method: "GET", url: `/warmups/${recipe.id}` });
    expect(after.statusCode).toBe(404);
  });

  it("rejects an empty step list and bad urls", async () => {
    const ctx = makeTestContext();
    const empty = await ctx.app.inject({
      method: "POST",
      url: "/warmups",
      payload: { name: "x", steps: [] },
    });
    expect(empty.statusCode).toBe(400);
    const bad = await ctx.app.inject({
      method: "POST",
      url: "/warmups",
      payload: { name: "x", steps: [{ url: "not-a-url", dwellMs: 1 }] },
    });
    expect(bad.statusCode).toBe(400);
  });

  it("records a live session: URL order preserved, dwell captured", { timeout: 20000 }, async () => {
    const ctx = makeTestContext();
    const p = ctx.profiles.create({ name: "rec", generateFingerprint: true });
    await ctx.app.inject({ method: "POST", url: `/profiles/${p.id}/start`, payload: {} });

    await ctx.app.inject({ method: "POST", url: `/profiles/${p.id}/tabs`, payload: { url: "https://a.example.com" } });
    await new Promise((r) => setTimeout(r, 400));
    await ctx.app.inject({ method: "POST", url: `/profiles/${p.id}/tabs`, payload: { url: "https://b.example.com" } });

    const rec = await ctx.app.inject({
      method: "POST",
      url: `/profiles/${p.id}/warmup/record`,
      payload: { name: "session-1", durationMs: 900, sampleIntervalMs: 100 },
    });
    expect(rec.statusCode).toBe(201);
    const recipe = rec.json();
    expect(recipe.name).toBe("session-1");
    expect(recipe.sourceProfileId).toBe(p.id);
    const urls = recipe.steps.map((s: { url: string }) => s.url);
    expect(urls).toContain("https://a.example.com");
    expect(urls).toContain("https://b.example.com");
    expect(urls.indexOf("https://a.example.com")).toBeLessThan(urls.indexOf("https://b.example.com"));
    for (const s of recipe.steps) expect(s.dwellMs).toBeGreaterThanOrEqual(0);
  });

  it("recording a non-running profile 409s instead of capturing nothing", async () => {
    const ctx = makeTestContext();
    const p = ctx.profiles.create({ name: "idle", generateFingerprint: true });
    const res = await ctx.app.inject({
      method: "POST",
      url: `/profiles/${p.id}/warmup/record`,
      payload: { name: "nope", durationMs: 1000 },
    });
    expect(res.statusCode).toBe(409);
  });

  it("play starts an idle profile and replays every step; stopAfter shuts it down", { timeout: 20000 }, async () => {
    const ctx = makeTestContext();
    const created = await ctx.app.inject({
      method: "POST",
      url: "/warmups",
      payload: {
        name: "replay",
        steps: [
          { url: "https://one.example.com", dwellMs: 60 },
          { url: "https://two.example.com", dwellMs: 60 },
        ],
      },
    });
    const recipe = created.json();
    const target = ctx.profiles.create({ name: "target", generateFingerprint: true });

    const run = await ctx.app.inject({
      method: "POST",
      url: `/warmups/${recipe.id}/run`,
      payload: { profileId: target.id, stopAfter: true },
    });
    expect(run.statusCode).toBe(200);
    const body = run.json();
    expect(body.startedByRun).toBe(true);
    expect(body.results).toHaveLength(2);
    expect(body.results.every((r: { ok: boolean }) => r.ok)).toBe(true);
    // Jitter keeps dwells near (never exactly) the recorded value.
    for (const r of body.results) {
      expect(r.dwellMs).toBeGreaterThanOrEqual(60 * 0.7);
      expect(r.dwellMs).toBeLessThanOrEqual(60 * 1.3);
    }
    // stopAfter → back to idle.
    const after = await ctx.app.inject({ method: "GET", url: `/profiles/${target.id}` });
    expect(after.json().status).toBe("idle");
  });

  it("play leaves the profile running by default (warmed engine stays up)", async () => {
    const ctx = makeTestContext();
    const created = await ctx.app.inject({
      method: "POST",
      url: "/warmups",
      payload: { name: "stay-up", steps: [{ url: "https://x.example.com", dwellMs: 50 }] },
    });
    const target = ctx.profiles.create({ name: "t2", generateFingerprint: true });
    await ctx.app.inject({
      method: "POST",
      url: `/warmups/${created.json().id}/run`,
      payload: { profileId: target.id },
    });
    const after = await ctx.app.inject({ method: "GET", url: `/profiles/${target.id}` });
    expect(after.json().status).toBe("running");
  });
});
