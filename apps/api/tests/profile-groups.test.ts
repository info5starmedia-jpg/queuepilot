import { describe, expect, it } from "vitest";
import { makeTestContext } from "./helpers.js";

describe("GET /profile-groups", () => {
  it("aggregates every group with total and running counts", async () => {
    const ctx = makeTestContext();
    const a = ctx.profiles.create({ name: "g-a1", group: "ads", generateFingerprint: true });
    ctx.profiles.create({ name: "g-a2", group: "ads", generateFingerprint: true });
    ctx.profiles.create({ name: "g-s1", group: "shop", generateFingerprint: true });
    ctx.profiles.create({ name: "g-d1", generateFingerprint: true }); // default group

    await ctx.app.inject({ method: "POST", url: `/profiles/${a.id}/start`, payload: {} });

    const res = await ctx.app.inject({ method: "GET", url: "/profile-groups" });
    expect(res.statusCode).toBe(200);
    const { groups } = res.json();
    expect(groups).toEqual([
      { group: "ads", total: 2, running: 1 },
      { group: "default", total: 1, running: 0 },
      { group: "shop", total: 1, running: 0 },
    ]);
  });

  it("returns an empty list when there are no profiles", async () => {
    const ctx = makeTestContext();
    const res = await ctx.app.inject({ method: "GET", url: "/profile-groups" });
    expect(res.json()).toEqual({ groups: [] });
  });

  it("group filter on GET /profiles still narrows the grid", async () => {
    const ctx = makeTestContext();
    ctx.profiles.create({ name: "f-a", group: "ads", generateFingerprint: true });
    ctx.profiles.create({ name: "f-b", group: "shop", generateFingerprint: true });
    const res = await ctx.app.inject({ method: "GET", url: "/profiles?group=ads" });
    const { profiles } = res.json();
    expect(profiles).toHaveLength(1);
    expect(profiles[0].name).toBe("f-a");
  });
});
