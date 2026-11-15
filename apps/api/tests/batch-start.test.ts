import { describe, expect, it } from "vitest";
import { makeTestContext } from "./helpers.js";

describe("POST /profiles/batch-start", () => {
  it("starts every selected profile and reports per-profile results", async () => {
    const ctx = makeTestContext();
    const a = ctx.profiles.create({ name: "batch-a", generateFingerprint: true });
    const b = ctx.profiles.create({ name: "batch-b", generateFingerprint: true });

    const res = await ctx.app.inject({
      method: "POST",
      url: "/profiles/batch-start",
      payload: { ids: [a.id, b.id] },
    });
    expect(res.statusCode).toBe(200);
    const { results } = res.json();
    expect(results).toHaveLength(2);
    expect(results.every((r: { status: string }) => r.status === "started")).toBe(true);
    expect(ctx.profiles.get(a.id).status).toBe("running");
    expect(ctx.profiles.get(b.id).status).toBe("running");
  });

  it("one failure never aborts the batch", async () => {
    const ctx = makeTestContext();
    const ok = ctx.profiles.create({ name: "batch-ok", generateFingerprint: true });

    const res = await ctx.app.inject({
      method: "POST",
      url: "/profiles/batch-start",
      payload: { ids: ["no-such-profile", ok.id] },
    });
    expect(res.statusCode).toBe(200);
    const { results } = res.json();
    expect(results[0]).toMatchObject({ id: "no-such-profile", status: "failed" });
    expect(results[0].error.code).toBe("PROFILE_NOT_FOUND");
    expect(results[1]).toMatchObject({ id: ok.id, status: "started" });
    expect(ctx.profiles.get(ok.id).status).toBe("running");
  });

  it("an already-running profile fails its row and the rest still start", async () => {
    const ctx = makeTestContext();
    const a = ctx.profiles.create({ name: "batch-run", generateFingerprint: true });
    const b = ctx.profiles.create({ name: "batch-next", generateFingerprint: true });
    await ctx.app.inject({ method: "POST", url: `/profiles/${a.id}/start`, payload: {} });

    const res = await ctx.app.inject({
      method: "POST",
      url: "/profiles/batch-start",
      payload: { ids: [a.id, b.id] },
    });
    const { results } = res.json();
    expect(results[0]).toMatchObject({ id: a.id, status: "failed" });
    expect(results[0].error.code).toBe("PROFILE_ALREADY_RUNNING");
    expect(results[1].status).toBe("started");
  });

  it("staggers starts by staggerMs", async () => {
    const ctx = makeTestContext();
    const a = ctx.profiles.create({ name: "batch-s1", generateFingerprint: true });
    const b = ctx.profiles.create({ name: "batch-s2", generateFingerprint: true });
    const t0 = Date.now();
    const res = await ctx.app.inject({
      method: "POST",
      url: "/profiles/batch-start",
      payload: { ids: [a.id, b.id], staggerMs: 120 },
    });
    expect(res.statusCode).toBe(200);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(110);
    expect(res.json().results.every((r: { status: string }) => r.status === "started")).toBe(true);
  });

  it("rejects bad input with 400", async () => {
    const ctx = makeTestContext();
    const empty = await ctx.app.inject({
      method: "POST",
      url: "/profiles/batch-start",
      payload: { ids: [] },
    });
    expect(empty.statusCode).toBe(400);
    const badStagger = await ctx.app.inject({
      method: "POST",
      url: "/profiles/batch-start",
      payload: { ids: ["x"], staggerMs: -1 },
    });
    expect(badStagger.statusCode).toBe(400);
  });
});
