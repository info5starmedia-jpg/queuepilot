import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { installPluginFile, PluginImportError } from "../src/application/plugins/plugin-import.js";
import { readZip, safeZipName } from "../src/application/plugins/zip-reader.js";
import { PluginRegistry } from "../src/application/plugins/plugin-registry.js";
import { ResolverRegistry } from "../src/application/resolvers/resolver-registry.js";
import { ParserRegistry } from "../src/application/parsers/parser-registry.js";
import { makeTestContext } from "./helpers.js";
import { FakeBrowserRuntime } from "../src/application/runtime/fake.browser-runtime.js";

/**
 * Plugin import (B3): a script or zip becomes a plugin folder that lands
 * DISABLED and is not even imported until the owner enables it; archives are
 * read defensively (traversal, absolute paths, symlinks, size caps); the
 * route sits behind the scripting gate and the browser-origin deny.
 */

/** Minimal zip writer for fixtures. `unixMode` lets a test forge a symlink. */
function makeZip(files: Array<{ name: string; data?: string; unixMode?: number; deflate?: boolean }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const raw = Buffer.from(f.data ?? "");
    const body = f.deflate ? zlib.deflateRawSync(raw) : raw;
    const name = Buffer.from(f.name, "utf8");
    const crc = zlib.crc32(raw) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(f.deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(f.unixMode !== undefined ? (3 << 8) | 20 : 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(f.deflate ? 8 : 0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((f.unixMode ?? 0) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const PLUGIN_SRC = `
  globalThis.__qpImportProbe = (globalThis.__qpImportProbe ?? 0) + 1;
  export async function onEnabled(ctx) { ctx.resolvers.register("hi", async () => "hello"); }
`;

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "qp-plugin-import-"));

function registry(pluginsDir: string) {
  const resolvers = new ResolverRegistry();
  const parsers = new ParserRegistry(path.join(path.dirname(pluginsDir), "parsers"));
  return { resolvers, plugins: new PluginRegistry(pluginsDir, resolvers, parsers) };
}

describe("installPluginFile", () => {
  it("wraps a single .mjs as a minimal plugin that lands disabled", () => {
    const dir = tmpDir();
    const r = installPluginFile(dir, "My Script.mjs", Buffer.from(PLUGIN_SRC));
    expect(r).toEqual({ id: "my-script", name: "my-script" });
    const pdir = path.join(dir, "my-script");
    expect(JSON.parse(fs.readFileSync(path.join(pdir, "package.json"), "utf8"))).toMatchObject({ name: "my-script", main: "index.mjs" });
    expect(fs.readFileSync(path.join(pdir, "index.mjs"), "utf8")).toBe(PLUGIN_SRC);
    expect(JSON.parse(fs.readFileSync(path.join(pdir, "enabled.json"), "utf8"))).toEqual({ enabled: false });
  });

  it("installs a zip with one top-level folder (deflated entries)", () => {
    const dir = tmpDir();
    const zip = makeZip([
      { name: "sms-tool/" },
      { name: "sms-tool/package.json", data: JSON.stringify({ name: "@me/sms-tool", main: "lib/main.mjs" }), deflate: true },
      { name: "sms-tool/lib/main.mjs", data: PLUGIN_SRC, deflate: true },
      { name: "sms-tool/enabled.json", data: JSON.stringify({ enabled: true }) },
    ]);
    expect(installPluginFile(dir, "sms-tool.zip", zip)).toEqual({ id: "sms-tool", name: "@me/sms-tool" });
    expect(fs.readFileSync(path.join(dir, "sms-tool", "lib", "main.mjs"), "utf8")).toBe(PLUGIN_SRC);
    // The archive's own enabled.json never wins.
    expect(JSON.parse(fs.readFileSync(path.join(dir, "sms-tool", "enabled.json"), "utf8"))).toEqual({ enabled: false });
  });

  it("rejects traversal, absolute paths, drive letters and symlinks — and writes nothing", () => {
    const evil: Array<[string, Parameters<typeof makeZip>[0]]> = [
      ["traversal", [{ name: "package.json", data: '{"name":"x"}' }, { name: "../evil.mjs", data: "x" }]],
      ["nested traversal", [{ name: "p/package.json", data: '{"name":"x"}' }, { name: "p/a/../../../evil.mjs", data: "x" }]],
      ["backslash traversal", [{ name: "package.json", data: '{"name":"x"}' }, { name: "..\\evil.mjs", data: "x" }]],
      ["absolute", [{ name: "package.json", data: '{"name":"x"}' }, { name: "/etc/evil.mjs", data: "x" }]],
      ["drive letter", [{ name: "package.json", data: '{"name":"x"}' }, { name: "C:/evil.mjs", data: "x" }]],
      ["symlink", [{ name: "package.json", data: '{"name":"x","main":"index.mjs"}' }, { name: "index.mjs", data: "/etc/passwd", unixMode: 0o120777 }]],
      ["main escapes", [{ name: "package.json", data: '{"name":"x","main":"../../outside.mjs"}' }, { name: "index.mjs", data: "x" }]],
    ];
    for (const [label, files] of evil) {
      const dir = tmpDir();
      expect(() => installPluginFile(dir, "x.zip", makeZip(files)), label).toThrow(PluginImportError);
      expect(fs.readdirSync(dir), label).toEqual([]); // no plugin, no leftover staging folder
      expect(fs.existsSync(path.join(path.dirname(dir), "evil.mjs")), label).toBe(false);
    }
  });

  it("enforces caps and refuses junk, unknown types and duplicates", () => {
    const dir = tmpDir();
    expect(() => installPluginFile(dir, "x.mjs", Buffer.alloc(6 * 1024 * 1024, 32))).toThrow(/larger than/);
    expect(() => installPluginFile(dir, "x.exe", Buffer.from("MZ"))).toThrow(/unsupported file type/);
    expect(() => installPluginFile(dir, "x.zip", Buffer.from("not a zip"))).toThrow(/not a zip/);
    expect(() => installPluginFile(dir, "x.zip", makeZip([{ name: "readme.txt", data: "hi" }]))).toThrow(/package.json/);
    const bomb = makeZip([{ name: "package.json", data: '{"name":"b"}' }, { name: "index.mjs", data: "x".repeat(21 * 1024 * 1024), deflate: true }]);
    expect(() => installPluginFile(dir, "b.zip", bomb)).toThrow(/expands past/);
    installPluginFile(dir, "dup.mjs", Buffer.from("export {}"));
    expect(() => installPluginFile(dir, "dup.mjs", Buffer.from("export {}"))).toThrow(/already installed/);
  });

  it("safeZipName accepts ordinary nested names", () => {
    expect(safeZipName("lib/a.mjs")).toBe("lib/a.mjs");
    expect(safeZipName("lib\\b.mjs")).toBe("lib/b.mjs");
    expect(readZip(makeZip([{ name: "a.txt", data: "ok" }]), { maxEntries: 5, maxTotalBytes: 100 })[0]!.data.toString()).toBe("ok");
  });
});

describe("disabled-by-default registry behaviour", () => {
  it("an imported plugin is listed disabled and its code never runs until enabled", async () => {
    const dir = tmpDir();
    (globalThis as { __qpImportProbe?: number }).__qpImportProbe = 0;
    installPluginFile(dir, "probe.mjs", Buffer.from(PLUGIN_SRC));
    const { resolvers, plugins } = registry(dir);
    await plugins.rescan();
    expect(plugins.list()).toEqual([expect.objectContaining({ id: "probe", enabled: false, loaded: false, error: null })]);
    expect((globalThis as { __qpImportProbe?: number }).__qpImportProbe).toBe(0); // not even imported

    await plugins.setEnabled("probe", true);
    expect((globalThis as { __qpImportProbe?: number }).__qpImportProbe).toBe(1);
    expect(plugins.list()[0]).toMatchObject({ enabled: true, loaded: true });
    expect(await resolvers.resolve("plugin.probe.hi", {})).toBe("hello");
  });

  it("staging folders are never loaded as plugins", async () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, ".import-leftover"));
    const { plugins } = registry(dir);
    await plugins.rescan();
    expect(plugins.list()).toEqual([]);
  });
});

describe("POST /plugins/import", () => {
  const AUTH = { authorization: "Bearer test-token" };
  /** Production shape: API token set, scripting opted in unless `open` is false. */
  const gated = (open = true) => {
    const ctx = makeTestContext(new FakeBrowserRuntime(), { apiToken: "test-token" });
    if (open) ctx.settings.patch("automation", { scriptingEndpoints: true });
    return ctx;
  };
  const upload = (ctx: ReturnType<typeof makeTestContext>, filename: string, body: Buffer, headers: Record<string, string> = AUTH) =>
    ctx.app.inject({
      method: "POST",
      url: `/plugins/import?filename=${encodeURIComponent(filename)}`,
      headers: { "content-type": "application/octet-stream", ...headers },
      payload: body,
    });

  it("is refused while the scripting gate is closed, and without the token", async () => {
    const closed = await upload(gated(false), "a.mjs", Buffer.from(PLUGIN_SRC));
    expect(closed.statusCode).toBe(403);
    const noToken = await upload(gated(), "a.mjs", Buffer.from(PLUGIN_SRC), {});
    expect(noToken.statusCode).toBe(401);
    // An install built without a token can never open the gate.
    const tokenless = makeTestContext();
    tokenless.settings.patch("automation", { scriptingEndpoints: true });
    expect((await upload(tokenless, "a.mjs", Buffer.from(PLUGIN_SRC), {})).statusCode).toBe(403);
    expect(fs.existsSync(path.join(tokenless.dataDir, "plugins", "a"))).toBe(false);
  });

  it("refuses browser-originated requests even with the gate open", async () => {
    const ctx = gated();
    const res = await upload(ctx, "a.mjs", Buffer.from(PLUGIN_SRC), { ...AUTH, "sec-fetch-site": "cross-site" });
    expect(res.statusCode).toBe(403);
    const res2 = await upload(ctx, "a.mjs", Buffer.from(PLUGIN_SRC), { ...AUTH, origin: "https://evil.example" });
    expect(res2.statusCode).toBe(403);
    expect(fs.existsSync(path.join(ctx.dataDir, "plugins", "a"))).toBe(false);
  });

  it("installs a file through the gate: listed, disabled, per-file report", async () => {
    const ctx = gated();
    const res = await upload(ctx, "hello.mjs", Buffer.from(PLUGIN_SRC));
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ installed: [{ file: "hello.mjs", id: "hello", name: "hello", enabled: false }], rejected: [] });
    const list = (await ctx.app.inject({ method: "GET", url: "/plugins", headers: AUTH })).json().plugins;
    expect(list).toEqual([expect.objectContaining({ id: "hello", enabled: false, loaded: false })]);
  });

  it("a rejected file is loud: 422 with the reason", async () => {
    const ctx = gated();
    const res = await upload(ctx, "evil.zip", makeZip([{ name: "package.json", data: '{"name":"e"}' }, { name: "../x.mjs", data: "x" }]));
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.installed).toEqual([]);
    expect(body.rejected[0]).toMatchObject({ file: "evil.zip" });
    expect(body.rejected[0].reason).toMatch(/traversal/);
  });
});
