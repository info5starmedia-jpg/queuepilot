import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JylRegistry } from "../src/application/jyl/jyl-registry.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "qp-jyl-test-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function writeModule(name: string, body: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), body);
}

describe("JylRegistry", () => {
  it("loads commands and macros, runs a command with ctx args/store/log", async () => {
    writeModule("toolkit.mjs", `
      export const queuepilotJyl = {
        commands: [{
          name: "greet",
          description: "say hi",
          async run(ctx, args) {
            ctx.log("greeting", args);
            const n = ctx.store.get("count", 0);
            ctx.store.set("count", n + 1);
            return { hello: args, count: n + 1 };
          },
        }],
        macros: [{
          name: "onboard",
          description: "greet twice",
          steps: [{ command: "greet", args: "world" }, { command: "greet", args: "{args}" }],
        }],
      };
    `);
    const reg = new JylRegistry(dir);
    const scan = await reg.rescan();
    if (scan.loaded === 0) console.error("JYL-DEBUG errors=" + JSON.stringify(scan.errors));
    expect(scan.loaded).toBe(1);
    const list = reg.list();
    expect(list.commands[0]).toMatchObject({ name: "greet", source: "toolkit.mjs" });
    expect(list.macros[0]).toMatchObject({ name: "onboard", steps: 2 });

    const r1 = await reg.runCommand("greet", "alice", {});
    expect(r1.ok).toBe(true);
    expect(r1.result).toEqual({ hello: "alice", count: 1 });
    const r2 = await reg.runCommand("greet", "bob", {});
    expect(r2.result).toEqual({ hello: "bob", count: 2 });
    expect(reg.recentLogs().length).toBeGreaterThan(0);
  });

  it("macros run steps in order, substitute {args}, stop on first failure", async () => {
    writeModule("m.mjs", `
      export const queuepilotJyl = {
        commands: [
          { name: "ok", run: (_ctx, args) => "ran:" + args },
          { name: "boom", run: () => { throw new Error("kaput"); } },
        ],
        macros: [
          { name: "good", steps: [{ command: "ok", args: "{args}!" }, "ok"] },
          { name: "bad", steps: [{ command: "ok", args: "a" }, { command: "boom" }, { command: "ok" }] },
        ],
      };
    `);
    const reg = new JylRegistry(dir);
    await reg.rescan();

    const good = await reg.runMacro("good", "x", {});
    expect(good.ok).toBe(true);
    expect(good.steps).toHaveLength(2);
    expect(good.steps![0]).toMatchObject({ index: 0, command: "ok", result: "ran:x!" });

    const bad = await reg.runMacro("bad", "", {});
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain("step 1");
    expect(bad.steps).toHaveLength(2); // third step never ran
    expect(bad.steps![1]).toMatchObject({ command: "boom", ok: false, error: "kaput" });
  });

  it("unknown names are #NO COMMAND / #NO MACRO, never throws", async () => {
    const reg = new JylRegistry(dir);
    await reg.rescan();
    expect((await reg.runCommand("ghost", "", {})).error).toBe("#NO COMMAND ghost");
    expect((await reg.runMacro("ghost", "", {})).error).toBe("#NO MACRO ghost");
  });

  it("a bad module is reported, not fatal; duplicates across modules are rejected", async () => {
    writeModule("broken.mjs", `throw new Error("nope");`);
    writeModule("dup-a.mjs", `
      export const queuepilotJyl = { commands: [{ name: "same", run: () => 1 }] };
    `);
    writeModule("dup-b.mjs", `
      export const queuepilotJyl = { commands: [{ name: "same", run: () => 2 }] };
    `);
    const reg = new JylRegistry(dir);
    const scan = await reg.rescan();
    if (scan.loaded === 0) console.error("JYL-DEBUG errors=" + JSON.stringify(scan.errors));
    expect(scan.loaded).toBe(1); // only dup-a (alphabetical) survives
    expect(scan.errors.map((e) => e.file).sort()).toEqual(["broken.mjs", "dup-b.mjs"]);
  });

  it("a throwing command returns ok:false with the message; results stay JSON-able", async () => {
    writeModule("t.mjs", `
      export const queuepilotJyl = {
        commands: [
          { name: "nothing", run: () => {} },
          { name: "circular", run: () => { const o = {}; o.self = o; return o; } },
          { name: "thrower", run: () => { throw new Error("bad input"); } },
        ],
      };
    `);
    const reg = new JylRegistry(dir);
    await reg.rescan();
    expect(await reg.runCommand("nothing", "", {})).toEqual({ ok: true, result: null });
    const circular = await reg.runCommand("circular", "", {});
    expect(circular.ok).toBe(true);
    expect(() => JSON.stringify(circular.result)).not.toThrow();
    expect(await reg.runCommand("thrower", "", {})).toEqual({ ok: false, error: "bad input" });
  });

  it("endpoints dispatch by module + path + method with query/body/store", async () => {
    writeModule("panel.mjs", `
      export const queuepilotJyl = {
        endpoints: [
          {
            name: "status",
            path: "status",
            method: "GET",
            handler(ctx) {
              const hits = ctx.store.get("hits", 0);
              ctx.store.set("hits", hits + 1);
              ctx.log("status ping", ctx.query.q ?? "-");
              return { ok: true, q: ctx.query.q ?? null, hits: hits + 1 };
            },
          },
          {
            name: "echo",
            path: "echo",
            method: "POST",
            handler: (ctx) => ({ got: ctx.body }),
          },
        ],
      };
    `);
    const reg = new JylRegistry(dir);
    const scan = await reg.rescan();
    expect(scan.errors).toEqual([]);
    expect(reg.list().endpoints).toEqual([
      { name: "status", path: "status", method: "GET", source: "panel.mjs" },
      { name: "echo", path: "echo", method: "POST", source: "panel.mjs" },
    ]);

    const r1 = await reg.dispatch("GET", "panel.mjs/status", { query: { q: "hi" }, body: null });
    expect(r1).toEqual({ found: true, result: { ok: true, q: "hi", hits: 1 } });
    const r2 = await reg.dispatch("GET", "panel.mjs/status", { query: {}, body: null });
    expect(r2).toEqual({ found: true, result: { ok: true, q: null, hits: 2 } });

    const echo = await reg.dispatch("POST", "panel.mjs/echo", { query: {}, body: { a: 1 } });
    expect(echo).toEqual({ found: true, result: { got: { a: 1 } } });

    // Wrong method and unknown module are 404s, not errors.
    expect(await reg.dispatch("POST", "panel.mjs/status", { query: {}, body: null })).toEqual({ found: false });
    expect(await reg.dispatch("GET", "ghost.mjs/status", { query: {}, body: null })).toEqual({ found: false });
  });

  it("endpoint validation rejects bad paths, methods, and duplicates loudly", async () => {
    writeModule("bad.mjs", `
      export const queuepilotJyl = {
        endpoints: [
          { path: "../escape", handler: () => 1 },
        ],
      };
    `);
    writeModule("badmethod.mjs", `
      export const queuepilotJyl = {
        endpoints: [
          { path: "x", method: "TELEPORT", handler: () => 1 },
        ],
      };
    `);
    writeModule("dup.mjs", `
      export const queuepilotJyl = {
        endpoints: [
          { path: "same", method: "GET", handler: () => 1 },
          { path: "same", method: "get", handler: () => 2 },
        ],
      };
    `);
    const reg = new JylRegistry(dir);
    const scan = await reg.rescan();
    expect(scan.loaded).toBe(0);
    expect(scan.errors).toHaveLength(3);
    expect(scan.errors[0]!.error).toContain("not a clean relative path");
    expect(scan.errors[1]!.error).toContain("TELEPORT");
    expect(scan.errors[2]!.error).toContain("defined twice");
  });

  it("a throwing endpoint surfaces as a 500-flavored error from dispatch", async () => {
    writeModule("boom.mjs", `
      export const queuepilotJyl = {
        endpoints: [{ path: "go", handler: () => { throw new Error("kaput"); } }],
      };
    `);
    const reg = new JylRegistry(dir);
    await reg.rescan();
    await expect(
      reg.dispatch("GET", "boom.mjs/go", { query: {}, body: null }),
    ).rejects.toMatchObject({ statusCode: 500, message: expect.stringContaining("kaput") });
  });
});
