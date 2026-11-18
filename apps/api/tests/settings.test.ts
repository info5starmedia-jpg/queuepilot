import { describe, expect, it } from "vitest";
import { makeTestContext } from "./helpers.js";
import { openDatabase } from "../src/infrastructure/database.js";
import { SettingsService } from "../src/application/settings/settings.service.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("SettingsService", () => {
  it("returns contract defaults when nothing is stored", () => {
    const ctx = makeTestContext();
    const all = ctx.settings.getAll();
    expect(all.general.theme).toBe("jancy");
    expect(all.general.startOnBoot).toBe(false);
    expect(all.engine.channel).toBe("stable");
    expect(all.engine.downloadConsent).toBe(false);
    expect(all.launch.batchStaggerMs).toBe(0);
    expect(all.launch.maxConcurrent).toBe(0);
    expect(all.launch.openStartPages).toBe(true);
    expect(all.team.serverUrl).toBeNull();
    expect(all.team.syncGroups).toEqual([]);
    expect(all.integrations.googleAccount).toBeNull();
    expect(all.automation.enabledPlugins).toEqual([]);
  });

  it("patch merges shallowly and absent keys keep stored values", () => {
    const ctx = makeTestContext();
    const first = ctx.settings.patch("general", { theme: "light" });
    expect(first.theme).toBe("light");
    expect(first.language).toBe("en"); // untouched key keeps default
    const second = ctx.settings.patch("general", { language: "es" });
    expect(second.theme).toBe("light"); // earlier patch survives
    expect(second.language).toBe("es");
  });

  it("persists across service instances over the same db file (restart)", () => {
    const dbPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "qp-settings-test-")),
      "test.db",
    );
    const db = openDatabase(dbPath);
    new SettingsService(db).patch("launch", { batchStaggerMs: 1500, maxConcurrent: 12 });
    db.close();

    const db2 = openDatabase(dbPath);
    const reloaded = new SettingsService(db2).get("launch");
    expect(reloaded.batchStaggerMs).toBe(1500);
    expect(reloaded.maxConcurrent).toBe(12);
    expect(reloaded.openStartPages).toBe(true); // default backfill
    db2.close();
  });

  it("rejects invalid patch values with a zod error", () => {
    const ctx = makeTestContext();
    expect(() => ctx.settings.patch("launch", { batchStaggerMs: -5 })).toThrow();
    expect(() => ctx.settings.patch("general", { theme: "neon" })).toThrow();
    expect(() => ctx.settings.patch("team", { serverUrl: "not-a-url" })).toThrow();
  });

  it("rejects unknown sections", () => {
    const ctx = makeTestContext();
    expect(() => ctx.settings.get("nope")).toThrow(/unknown settings section/);
    expect(() => ctx.settings.patch("nope", {})).toThrow(/unknown settings section/);
  });
});

describe("settings HTTP routes", () => {
  it("GET /settings/sections returns every section with defaults", async () => {
    const ctx = makeTestContext();
    const res = await ctx.app.inject({ method: "GET", url: "/settings/sections" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.general.theme).toBe("jancy");
    expect(Object.keys(body).sort()).toEqual(
      ["agent", "automation", "engine", "general", "integrations", "launch", "team"],
    );
    // P9: the agent's model is local by default.
    expect(body.agent).toEqual({ providerUrl: "http://127.0.0.1:11434", model: "qwen2.5:7b-instruct" });
  });

  it("PATCH merges then GET returns the merged document", async () => {
    const ctx = makeTestContext();
    const patch = await ctx.app.inject({
      method: "PATCH",
      url: "/settings/sections/launch",
      payload: { batchStaggerMs: 500 },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().batchStaggerMs).toBe(500);

    const get = await ctx.app.inject({ method: "GET", url: "/settings/sections/launch" });
    expect(get.json()).toMatchObject({ batchStaggerMs: 500, maxConcurrent: 0, openStartPages: true });
  });

  it("invalid patch body -> 400 VALIDATION_FAILED", async () => {
    const ctx = makeTestContext();
    const res = await ctx.app.inject({
      method: "PATCH",
      url: "/settings/sections/general",
      payload: { density: "squished" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_FAILED");
  });

  it("unknown section -> 400 VALIDATION_FAILED", async () => {
    const ctx = makeTestContext();
    const res = await ctx.app.inject({
      method: "PATCH",
      url: "/settings/sections/nope",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_FAILED");
  });

  it("bundle routes still work alongside section routes", async () => {
    const ctx = makeTestContext();
    const res = await ctx.app.inject({ method: "GET", url: "/settings/export" });
    expect(res.statusCode).toBe(200);
    expect(res.json().version).toBe(1);
  });
});
