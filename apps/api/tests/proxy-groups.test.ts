import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../src/infrastructure/database.js";
import { makeTestContext, type TestContext } from "./helpers.js";

/**
 * Proxy groups (B2) — the profile-groups model applied to proxies: a group
 * column (existing rows migrate to "default"), group on create/edit/import,
 * GET /proxies?group=, GET /proxy-groups, rename (no silent merge), and
 * batch-move for the select-all bar.
 */

const mk = (ctx: TestContext, host: string, group?: string) =>
  ctx.app.inject({ method: "POST", url: "/proxies", payload: { name: host, type: "http", host, port: 8080, ...(group ? { group } : {}) } });

describe("proxy groups", () => {
  it("migration 011 files every existing proxy under \"default\"", () => {
    const db = new Database(":memory:");
    migrate(db);
    // Roll the schema back to before 011 and insert a proxy the old way.
    db.exec("ALTER TABLE proxies DROP COLUMN grp; DELETE FROM schema_migrations WHERE id = '011-proxy-groups';");
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO proxies (id, name, type, host, port, created_at, updated_at) VALUES ('p1', 'old', 'http', '1.2.3.4', 80, ?, ?)",
    ).run(now, now);
    migrate(db);
    expect(db.prepare("SELECT grp FROM proxies WHERE id = 'p1'").get()).toEqual({ grp: "default" });
  });

  it("group is set on create (default \"default\") and changed on edit", async () => {
    const ctx = makeTestContext();
    const a = (await mk(ctx, "1.1.1.1")).json();
    const b = (await mk(ctx, "2.2.2.2", "ashburn")).json();
    expect(a.group).toBe("default");
    expect(b.group).toBe("ashburn");
    const edited = await ctx.app.inject({ method: "PATCH", url: `/proxies/${a.id}`, payload: { group: "germany" } });
    expect(edited.json().group).toBe("germany");
  });

  it("GET /proxies?group= filters; GET /proxy-groups counts total and in-use", async () => {
    const ctx = makeTestContext();
    const a = (await mk(ctx, "1.1.1.1", "ashburn")).json();
    await mk(ctx, "1.1.1.2", "ashburn");
    await mk(ctx, "3.3.3.3", "germany");
    ctx.profiles.create({ name: "uses-a", generateFingerprint: true, proxyId: a.id });

    const filtered = (await ctx.app.inject({ method: "GET", url: "/proxies?group=ashburn" })).json().proxies;
    expect(filtered.map((p: { host: string }) => p.host).sort()).toEqual(["1.1.1.1", "1.1.1.2"]);
    const { groups } = (await ctx.app.inject({ method: "GET", url: "/proxy-groups" })).json();
    expect(groups).toEqual([
      { group: "ashburn", total: 2, inUse: 1 },
      { group: "germany", total: 1, inUse: 0 },
    ]);
  });

  it("batch-move files the selection under a (new) group; unknown ids move nothing", async () => {
    const ctx = makeTestContext();
    const a = (await mk(ctx, "1.1.1.1")).json();
    const b = (await mk(ctx, "2.2.2.2")).json();
    const res = await ctx.app.inject({ method: "POST", url: "/proxies/batch-move", payload: { ids: [a.id, b.id], group: "isp" } });
    expect(res.json()).toEqual({ moved: 2 });
    expect(ctx.proxies.list("isp")).toHaveLength(2);

    const bad = await ctx.app.inject({
      method: "POST",
      url: "/proxies/batch-move",
      payload: { ids: [a.id, "00000000-0000-4000-8000-000000000000"], group: "other" },
    });
    expect(bad.statusCode).toBe(404);
    expect(ctx.proxies.get(a.id).group).toBe("isp");
  });

  it("rename moves a whole group but refuses to merge into an existing one", async () => {
    const ctx = makeTestContext();
    await mk(ctx, "1.1.1.1", "old");
    await mk(ctx, "2.2.2.2", "taken");
    const ok = await ctx.app.inject({ method: "POST", url: "/proxy-groups/rename", payload: { from: "old", to: "new" } });
    expect(ok.json()).toEqual({ renamed: 1 });
    const clash = await ctx.app.inject({ method: "POST", url: "/proxy-groups/rename", payload: { from: "new", to: "taken" } });
    expect(clash.statusCode).toBe(409);
  });

  it("import files every added proxy under the requested group", async () => {
    const ctx = makeTestContext();
    const res = await ctx.app.inject({ method: "POST", url: "/proxies/import", payload: { text: "4.4.4.4:1\n5.5.5.5:2", group: "batch-1" } });
    expect(res.json().added).toBe(2);
    expect(ctx.proxies.list("batch-1")).toHaveLength(2);
  });

  it("editing a password-protected proxy's group keeps its password", async () => {
    const ctx = makeTestContext();
    const p = await ctx.proxies.create({ name: "pw", type: "http", host: "6.6.6.6", port: 1, username: "u", password: "keep-me" });
    await ctx.app.inject({ method: "POST", url: "/proxies/batch-move", payload: { ids: [p.id], group: "g" } });
    expect(ctx.proxies.getStored(p.id).password).toBe("keep-me");
  });
});
