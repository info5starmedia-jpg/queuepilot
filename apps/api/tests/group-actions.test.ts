import { describe, expect, it } from "vitest";
import { makeTestContext } from "./helpers.js";

describe("group management (v0.14.17)", () => {
  it("renames a group across all its profiles", async () => {
    const ctx = makeTestContext();
    const a = ctx.profiles.create({ name: "r-a", group: "ads", generateFingerprint: true });
    ctx.profiles.create({ name: "r-b", group: "ads", generateFingerprint: true });
    ctx.profiles.create({ name: "r-c", group: "shop", generateFingerprint: true });

    const res = await ctx.app.inject({
      method: "POST",
      url: "/profile-groups/rename",
      payload: { from: "ads", to: "marketing" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ renamed: 2 });
    expect(ctx.profiles.get(a.id).group).toBe("marketing");
    const { groups } = (
      await ctx.app.inject({ method: "GET", url: "/profile-groups" })
    ).json();
    expect(groups.map((g: { group: string }) => g.group).sort()).toEqual(["marketing", "shop"]);
  });

  it("refuses to rename into an existing group (409, no silent merge)", async () => {
    const ctx = makeTestContext();
    ctx.profiles.create({ name: "m-a", group: "ads", generateFingerprint: true });
    ctx.profiles.create({ name: "m-b", group: "shop", generateFingerprint: true });
    const res = await ctx.app.inject({
      method: "POST",
      url: "/profile-groups/rename",
      payload: { from: "ads", to: "shop" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("CONFLICT");
  });

  it("unknown source group -> 404", async () => {
    const ctx = makeTestContext();
    const res = await ctx.app.inject({
      method: "POST",
      url: "/profile-groups/rename",
      payload: { from: "ghost", to: "elsewhere" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("batch-move moves every selected profile into the group", async () => {
    const ctx = makeTestContext();
    const a = ctx.profiles.create({ name: "mv-a", group: "ads", generateFingerprint: true });
    const b = ctx.profiles.create({ name: "mv-b", group: "shop", generateFingerprint: true });

    const res = await ctx.app.inject({
      method: "POST",
      url: "/profiles/batch-move",
      payload: { ids: [a.id, b.id], group: "archive" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ moved: 2 });
    expect(ctx.profiles.get(a.id).group).toBe("archive");
    expect(ctx.profiles.get(b.id).group).toBe("archive");
    // "archive" now exists as a tab even though it had no profiles before
    const { groups } = (
      await ctx.app.inject({ method: "GET", url: "/profile-groups" })
    ).json();
    expect(groups.map((g: { group: string }) => g.group)).toContain("archive");
  });

  it("batch-move on an unknown id -> 404 and earlier moves stand", async () => {
    const ctx = makeTestContext();
    const a = ctx.profiles.create({ name: "mv-partial", group: "ads", generateFingerprint: true });
    const res = await ctx.app.inject({
      method: "POST",
      url: "/profiles/batch-move",
      payload: { ids: [a.id, "no-such"], group: "archive" },
    });
    expect(res.statusCode).toBe(404);
    expect(ctx.profiles.get(a.id).group).toBe("archive"); // first id moved before the miss
  });
});
