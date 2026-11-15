import { describe, expect, it, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { makeTestContext, type TestContext } from "./helpers.js";

/**
 * HTTP surface for P7.10: module-provided JYL web endpoints (wildcard route
 * behind the API token) and secrets-free settings bundles.
 */

let ctx: TestContext;
beforeEach(() => {
  ctx = makeTestContext();
});

function writeJylModule(name: string, body: string): void {
  const dir = path.join(ctx.dataDir, "jyl");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), body);
}

describe("JYL web endpoints (HTTP)", () => {
  it("serves module endpoints under /jyl/endpoint/<module>/<path>", async () => {
    writeJylModule(
      "panel.mjs",
      `
      export const queuepilotJyl = {
        endpoints: [{
          name: "ping",
          path: "ping",
          method: "GET",
          handler(ctx) {
            const n = ctx.store.get("n", 0);
            ctx.store.set("n", n + 1);
            return { pong: ctx.query.q ?? null, n: n + 1 };
          },
        }],
      };
    `,
    );
    await ctx.jyl.rescan();

    const res = await ctx.app.inject({
      method: "GET",
      url: "/jyl/endpoint/panel.mjs/ping?q=hi",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ pong: "hi", n: 1 });

    const again = await ctx.app.inject({ method: "GET", url: "/jyl/endpoint/panel.mjs/ping" });
    expect(again.json()).toEqual({ pong: null, n: 2 });
  });

  it("POST endpoints receive the parsed JSON body", async () => {
    writeJylModule(
      "echo.mjs",
      `
      export const queuepilotJyl = {
        endpoints: [{
          path: "echo",
          method: "POST",
          handler: (ctx) => ({ got: ctx.body }),
        }],
      };
    `,
    );
    await ctx.jyl.rescan();

    const res = await ctx.app.inject({
      method: "POST",
      url: "/jyl/endpoint/echo.mjs/echo",
      payload: { a: 1 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ got: { a: 1 } });
  });

  it("unknown endpoint -> 404; throwing handler -> 500", async () => {
    writeJylModule(
      "boom.mjs",
      `
      export const queuepilotJyl = {
        endpoints: [{ path: "go", handler: () => { throw new Error("kaput"); } }],
      };
    `,
    );
    await ctx.jyl.rescan();

    const missing = await ctx.app.inject({ method: "GET", url: "/jyl/endpoint/nope.mjs/x" });
    expect(missing.statusCode).toBe(404);

    const boom = await ctx.app.inject({ method: "GET", url: "/jyl/endpoint/boom.mjs/go" });
    expect(boom.statusCode).toBe(500);
    expect(boom.body).toContain("kaput");
  });
});

describe("settings bundles (HTTP)", () => {
  it("export/import round-trips providers and plugin toggles without secrets", async () => {
    // One CSV-backed profile provider + one sheet-backed proxy provider.
    const csvPath = path.join(ctx.dataDir, "people.csv");
    fs.writeFileSync(csvPath, "key,name\nk1,Alice\n");
    ctx.sheets.sheets.set("sheet-1", [
      ["host:port:user:pass"],
      ["10.0.0.1:8000:u:p"],
    ]);
    await ctx.profileProviders.create({ name: "people", sourcePath: csvPath });
    await ctx.proxyProviders.create({
      name: "pool",
      sheetId: "sheet-1",
      delimiter: ":",
      distribution: "random",
    });

    // An alias exists; its VALUE must never appear in the export.
    ctx.aliases.set("mytoken", "SUPER-SECRET-VALUE");

    const res = await ctx.app.inject({ method: "GET", url: "/settings/export" });
    expect(res.statusCode).toBe(200);
    const bundle = res.json();
    expect(bundle.version).toBe(1);
    expect(bundle.aliases).toEqual(["mytoken"]);
    expect(JSON.stringify(bundle)).not.toContain("SUPER-SECRET-VALUE");
    expect(bundle.profileProviders[0]).toMatchObject({ name: "people", type: "csv" });
    expect(bundle.proxyProviders[0]).toMatchObject({
      name: "pool",
      type: "googleSheet",
      sheetId: "sheet-1",
      delimiter: ":",
      distribution: "random",
    });

    // Import into a fresh context: providers are created by name, alias
    // values are reported as not-imported (they're secrets).
    const ctx2 = makeTestContext();
    ctx2.sheets.sheets.set("sheet-1", [["host:port:user:pass"], ["10.0.0.1:8000:u:p"]]);
    // The exported sourcePath is machine-local and points at ctx's dataDir;
    // for the import to succeed the CSV must exist inside ctx2's allowed
    // roots (audit A-rec #2 containment).
    const csv2 = path.join(ctx2.dataDir, "people.csv");
    fs.writeFileSync(csv2, "key,name\nk1,Alice\n");
    bundle.profileProviders[0].sourcePath = csv2;
    const importRes = await ctx2.app.inject({
      method: "POST",
      url: "/settings/import",
      payload: bundle,
    });
    expect(importRes.statusCode).toBe(200);
    const out = importRes.json();
    expect(out.profileProviders).toMatchObject({ created: 1, existing: 0 });
    expect(out.proxyProviders).toMatchObject({ created: 1, existing: 0 });
    expect(out.aliases.imported).toBe(0);
    expect(out.aliases.note).toContain("secrets");

    // Re-import is a no-op (upsert by name).
    const again = await ctx2.app.inject({ method: "POST", url: "/settings/import", payload: bundle });
    expect(again.json().profileProviders).toMatchObject({ created: 0, existing: 1 });

    // A provider whose source is unreadable is reported, not fatal.
    const badBundle = {
      ...bundle,
      profileProviders: [
        { name: "ghost", type: "csv", sourcePath: "C:/no/such/file.csv", sheetId: null, sheetRange: null },
      ],
      proxyProviders: [],
      plugins: [],
      aliases: [],
    };
    const bad = await ctx2.app.inject({ method: "POST", url: "/settings/import", payload: badBundle });
    expect(bad.statusCode).toBe(200);
    expect(bad.json().profileProviders.failed).toHaveLength(1);
    expect(bad.json().profileProviders.failed[0].name).toBe("ghost");
  });

  it("rejects malformed bundles", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/settings/import",
      payload: { version: 99 },
    });
    expect(res.statusCode).toBe(400);
  });
});
