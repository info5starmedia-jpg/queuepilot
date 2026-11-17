import { describe, expect, it, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { makeTestContext, type TestContext } from "./helpers.js";
import { FakeBrowserRuntime } from "../src/application/runtime/fake.browser-runtime.js";

/**
 * HTTP surface for P7.10: module-provided JYL web endpoints (wildcard route
 * behind the API token) and secrets-free settings bundles.
 *
 * Audit GPT-5.4 finding 1 (v0.16): scripting endpoints now also require the
 * API to have been built WITH SPECTRA_API_TOKEN — the shared ctx carries a
 * token, so every request here authenticates like production would.
 */

const AUTH = { authorization: "Bearer test-token" };

let ctx: TestContext;
beforeEach(() => {
  ctx = makeTestContext(new FakeBrowserRuntime(), { apiToken: "test-token" });
  // These tests cover the scripting endpoints themselves — opt in.
  // The gate's fail-closed default has its own test below.
  ctx.settings.patch("automation", { scriptingEndpoints: true });
});

describe("scripting endpoint gate (audit A-rec #3, v0.15.0)", () => {
  it("refuses /jyl/run with 403 until the operator opts in", async () => {
    const locked = makeTestContext(new FakeBrowserRuntime(), { apiToken: "test-token" }); // default: scripting OFF
    const res = await locked.app.inject({
      method: "POST",
      url: "/jyl/run",
      headers: AUTH,
      payload: { kind: "command", name: "anything" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");

    locked.settings.patch("automation", { scriptingEndpoints: true });
    const dir = path.join(locked.dataDir, "jyl");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "toolkit.mjs"),
      `export const queuepilotJyl = { commands: [{ name: "hi", run: () => ({ ok: true }) }] };`,
    );
    await locked.app.inject({ method: "POST", url: "/jyl/rescan", headers: AUTH });
    const open = await locked.app.inject({
      method: "POST",
      url: "/jyl/run",
      headers: AUTH,
      payload: { kind: "command", name: "hi" },
    });
    expect(open.statusCode).toBe(200);
    expect(open.json()).toMatchObject({ ok: true });
  });

  it("refuses plugin/parser/resolver execution and alias writes when off", async () => {
    const locked = makeTestContext();
    for (const [method, url, payload] of [
      ["POST", "/plugins/rescan", {}],
      ["POST", "/parsers/rescan", {}],
      ["POST", "/resolvers/run", { spec: "static:1" }],
      ["PUT", "/aliases/x", { secret: "y" }],
      ["DELETE", "/aliases/x", {}],
    ] as const) {
      const res = await locked.app.inject({ method, url, payload });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.json().error.code, `${method} ${url}`).toBe("FORBIDDEN");
    }
    // Read-only routes stay reachable: listing is not execution.
    const list = await locked.app.inject({ method: "GET", url: "/plugins" });
    expect(list.statusCode).toBe(200);
  });
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
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ pong: "hi", n: 1 });

    const again = await ctx.app.inject({ method: "GET", url: "/jyl/endpoint/panel.mjs/ping", headers: AUTH });
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
      headers: AUTH,
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

    const missing = await ctx.app.inject({ method: "GET", url: "/jyl/endpoint/nope.mjs/x", headers: AUTH });
    expect(missing.statusCode).toBe(404);

    const boom = await ctx.app.inject({ method: "GET", url: "/jyl/endpoint/boom.mjs/go", headers: AUTH });
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

    const res = await ctx.app.inject({ method: "GET", url: "/settings/export", headers: AUTH });
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
      headers: AUTH,
      payload: { version: 99 },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("scripting auth hardening (audit GPT-5.4 finding 1)", () => {
  it("scripting enabled WITHOUT SPECTRA_API_TOKEN is refused at request time", async () => {
    // No token configured, scripting toggled on by direct store access — the
    // request-time gate must still refuse (message names the env var).
    const noToken = makeTestContext();
    noToken.settings.patch("automation", { scriptingEndpoints: true });
    const res = await noToken.app.inject({
      method: "POST",
      url: "/jyl/run",
      payload: { kind: "command", name: "anything" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toContain("SPECTRA_API_TOKEN");
  });

  it("the dashboard toggle cannot enable scripting while no token is configured", async () => {
    const noToken = makeTestContext();
    const res = await noToken.app.inject({
      method: "PATCH",
      url: "/settings/sections/automation",
      payload: { scriptingEndpoints: true },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toContain("SPECTRA_API_TOKEN");
    // And the setting really did not flip.
    expect(noToken.settings.get("automation").scriptingEndpoints).toBe(false);
  });

  it("cross-site browser requests to scripting endpoints are refused", async () => {
    const crossSite = await ctx.app.inject({
      method: "POST",
      url: "/jyl/run",
      headers: { ...AUTH, "sec-fetch-site": "cross-site" },
      payload: { kind: "command", name: "anything" },
    });
    expect(crossSite.statusCode).toBe(403);
    expect(crossSite.json().error.code).toBe("FORBIDDEN");

    const evilOrigin = await ctx.app.inject({
      method: "POST",
      url: "/plugins/rescan",
      headers: { ...AUTH, origin: "https://evil.example" },
      payload: {},
    });
    expect(evilOrigin.statusCode).toBe(403);
  });

  it("same-origin (dashboard) and header-less (CLI) requests still pass the origin check", async () => {
    const sameOrigin = await ctx.app.inject({
      method: "POST",
      url: "/plugins/rescan",
      headers: { ...AUTH, origin: "http://127.0.0.1:80" },
      payload: {},
    });
    expect(sameOrigin.statusCode).toBe(200);

    const cli = await ctx.app.inject({
      method: "POST",
      url: "/plugins/rescan",
      headers: AUTH,
      payload: {},
    });
    expect(cli.statusCode).toBe(200);
  });
});
