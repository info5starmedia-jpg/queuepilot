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
});
