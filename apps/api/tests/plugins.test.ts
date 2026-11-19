import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ResolverRegistry, registerBuiltinResolvers, parseSiteSpec, resolveSiteField } from "../src/application/resolvers/resolver-registry.js";
import { secretAliasStore, substituteAliases, type AliasStore } from "../src/application/resolvers/token-aliases.js";
import { ParserRegistry } from "../src/application/parsers/parser-registry.js";
import { PluginRegistry } from "../src/application/plugins/plugin-registry.js";

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "qp-plugins-test-"));
}

let dir: string;
beforeEach(() => { dir = tmpdir(); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("ResolverRegistry", () => {
  function make() {
    const reg = new ResolverRegistry();
    registerBuiltinResolvers(reg);
    return reg;
  }

  it("static returns its literal", async () => {
    const reg = make();
    expect(await reg.resolve("static:hunter2", {})).toBe("hunter2");
  });

  it("unknown resolver names the miss, never throws", async () => {
    const reg = make();
    expect(await reg.resolve("nosuch:x", {})).toBe("#NO RESOLVER nosuch");
  });

  it("webhook posts context and extracts the code by dotted path", async () => {
    const reg = make();
    const calls: unknown[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ data: { code: "482913" } }), { status: 200 });
    }) as typeof fetch;
    const v = await reg.resolve(
      "webhook:https://sms.example/fetch:data.code",
      { email: "a@b.c", site: "ticketmaster", field: "smscode", fetch: fakeFetch },
    );
    expect(v).toBe("482913");
    expect(calls).toEqual([
      { url: "https://sms.example/fetch", body: { email: "a@b.c", site: "ticketmaster", field: "smscode" } },
    ]);
  });

  it("webhook maps 401/403 to #NO ACCOUNT and empty code to #NO PASSWORD", async () => {
    const reg = make();
    const denied = (async () => new Response("no", { status: 403 })) as typeof fetch;
    expect(await reg.resolve("webhook:https://x/y", { fetch: denied })).toBe("#NO ACCOUNT");
    const empty = (async () => new Response("{}", { status: 200 })) as typeof fetch;
    expect(await reg.resolve("webhook:https://x/y", { fetch: empty })).toBe("#NO PASSWORD");
  });

  it("substitutes token aliases into resolver args, but static never returns one (SEC-1 F1)", async () => {
    const reg = make();
    const aliases: AliasStore = {
      set: () => {}, remove: () => {}, list: () => [],
      get: (a) => (a === "tm-token" ? "SECRET123" : null),
    };
    let seen = "";
    reg.register("probe", async (args) => {
      seen = args;
      return "ok";
    });
    await reg.resolve("probe:@tm-token", {}, aliases);
    expect(seen).toBe("SECRET123");
    expect(await reg.resolve("static:@tm-token", {}, aliases)).toMatch(/^#BAD ALIAS stored secrets are not returned/);
    expect(await reg.resolve("static:@unknown", {}, aliases)).toBe("@unknown");
  });

  it("env: only reads QP_VALUE_* variables (SEC-1 F1)", async () => {
    const reg = make();
    process.env.QP_VALUE_TEST_ONLY = "v1";
    expect(await reg.resolve("env:QP_VALUE_TEST_ONLY", {})).toBe("v1");
    delete process.env.QP_VALUE_TEST_ONLY;
    expect(await reg.resolve("env:SPECTRA_API_TOKEN", {})).toMatch(/^#BAD ALIAS env: only reads/);
    expect(await reg.resolve("env:PATH", {})).toMatch(/^#BAD ALIAS/);
  });
});

describe("substituteAliases / secretAliasStore", () => {
  it("leaves unknown aliases verbatim", () => {
    const store = secretAliasStore(new MapSecretStore());
    expect(substituteAliases("webhook:https://x/@nope:t", store)).toBe("webhook:https://x/@nope:t");
  });

  it("round-trips through a key-value secret store", () => {
    const kv = new MapSecretStore();
    const store = secretAliasStore(kv);
    store.set("tm", "s3cret");
    expect(store.get("tm")).toBe("s3cret");
    expect(substituteAliases("Bearer @tm", store)).toBe("Bearer s3cret");
    store.remove("tm");
    expect(store.get("tm")).toBeNull();
  });
});

class MapSecretStore {
  private m = new Map<string, string>();
  set(k: string, v: string) { this.m.set(k, v); }
  get(k: string) { return this.m.get(k) ?? null; }
  delete(k: string) { this.m.delete(k); }
}

describe("parseSiteSpec / resolveSiteField", () => {
  it("parses comma-separated field=resolver pairs", () => {
    expect(parseSiteSpec("password=static:hunter2, smscode=webhook:https://x/y:code, othercode=static:x")).toEqual({
      password: "static:hunter2",
      smscode: "webhook:https://x/y:code",
      othercode: "static:x",
    });
  });

  it("most-specific site wins, * is the wildcard, missing field is not found", async () => {
    const reg = new ResolverRegistry();
    registerBuiltinResolvers(reg);
    const sites = {
      "*": "password=static:wildpass",
      "ticketmaster": "password=static:tmpass, smscode=static:1111",
    };
    expect((await resolveSiteField(sites, "ticketmaster", "password", {}, reg)).value).toBe("tmpass");
    expect((await resolveSiteField(sites, "axs", "password", {}, reg)).value).toBe("wildpass");
    expect((await resolveSiteField(sites, "ticketmaster", "othercode", {}, reg)).found).toBe(false);
    expect((await resolveSiteField(undefined, "x", "y", {}, reg)).found).toBe(false);
  });
});

describe("ParserRegistry", () => {
  it("loads user .mjs parsers, runs them, reports bad files", async () => {
    const parsersDir = path.join(dir, "parsers");
    fs.mkdirSync(parsersDir, { recursive: true });
    fs.writeFileSync(path.join(parsersDir, "ticketmaster-v3.mjs"), `
      export default {
        kind: "email-parser",
        name: "ticketmaster-v3",
        parseMessage(m) {
          const x = /code is (\\d{6})/.exec(m.body);
          return x ? x[1] : null;
        },
      };
    `);
    fs.writeFileSync(path.join(parsersDir, "broken.mjs"), `throw new Error("nope");`);

    const reg = new ParserRegistry(parsersDir);
    const scan = await reg.rescan();
    expect(scan.loaded).toBe(1);
    expect(scan.errors).toHaveLength(1);
    expect(scan.errors[0]!.file).toBe("broken.mjs");

    expect(reg.run("ticketmaster-v3", { subject: "s", from: "f", body: "your code is 555123" })).toEqual({ ok: true, code: "555123" });
    expect(reg.run("ticketmaster-v3", { subject: "s", from: "f", body: "nothing here" })).toEqual({ ok: false });
    expect(reg.run("missing", { subject: "", from: "", body: "" })).toEqual({ ok: false, error: "#NO PARSER missing" });
  });
});

describe("PluginRegistry", () => {
  function writePlugin(id: string, body: string) {
    const pdir = path.join(dir, "plugins", id);
    fs.mkdirSync(pdir, { recursive: true });
    fs.writeFileSync(path.join(pdir, "package.json"), JSON.stringify({ name: id, version: "1.0.0", main: "index.mjs" }));
    fs.writeFileSync(path.join(pdir, "index.mjs"), body);
    return pdir;
  }

  function makeReg() {
    const resolvers = new ResolverRegistry();
    registerBuiltinResolvers(resolvers);
    const parsers = new ParserRegistry(path.join(dir, "parsers"));
    const plugins = new PluginRegistry(path.join(dir, "plugins"), resolvers, parsers);
    return { resolvers, parsers, plugins };
  }

  it("loads a plugin, runs lifecycle, exposes its resolver", async () => {
    writePlugin("smsdemo", `
      export const queuepilotProps = { registryVersion: 1, enabled: true };
      export async function onInit(ctx) { ctx.store.set("ready", true); }
      export async function onEnabled(ctx) {
        ctx.resolvers.register("demo", async () => "DEMO-CODE");
      }
    `);
    const { resolvers, plugins } = makeReg();
    const scan = await plugins.rescan();
    expect(scan.loaded).toBe(1);
    const list = plugins.list();
    expect(list[0]).toMatchObject({ id: "smsdemo", enabled: true, loaded: true });
    // plugin resolvers are namespaced so they can never shadow a builtin
    expect(await resolvers.resolve("plugin.smsdemo.demo", {})).toBe("DEMO-CODE");
  });

  it("a failing plugin is reported, never fatal", async () => {
    writePlugin("bad", `throw new Error("boot fail");`);
    const { plugins } = makeReg();
    const scan = await plugins.rescan();
    expect(scan.loaded).toBe(0);
    expect(scan.errors[0]!.id).toBe("bad");
    expect(plugins.list()[0]).toMatchObject({ id: "bad", loaded: false, enabled: false });
  });

  it("disabling unregisters contributions and persists the toggle", async () => {
    const pdir = writePlugin("tog", `
      export const queuepilotProps = { registryVersion: 1, enabled: true };
      export async function onEnabled(ctx) { ctx.resolvers.register("v", async () => "on"); }
    `);
    const { resolvers, plugins } = makeReg();
    await plugins.rescan();
    expect(await resolvers.resolve("plugin.tog.v", {})).toBe("on");

    await plugins.setEnabled("tog", false);
    expect(await resolvers.resolve("plugin.tog.v", {})).toBe("#NO RESOLVER plugin.tog.v");
    const persisted = JSON.parse(fs.readFileSync(path.join(pdir, "enabled.json"), "utf8"));
    expect(persisted.enabled).toBe(false);
  });

  it("rejects duplicate resolver registration from one plugin", async () => {
    writePlugin("dupe", `
      export async function onEnabled(ctx) {
        ctx.resolvers.register("v", async () => "1");
        ctx.resolvers.register("v", async () => "2");
      }
    `);
    const { plugins } = makeReg();
    const scan = await plugins.rescan();
    expect(scan.loaded).toBe(0);
    expect(scan.errors[0]!.error).toMatch(/already registered/);
  });

  it("concurrent store.set calls from a plugin lose no keys (audit 5b)", async () => {
    const pdir = writePlugin("racy", `
      export const queuepilotProps = { registryVersion: 1, enabled: true };
      export async function onEnabled(ctx) {
        // Two overlapping read-modify-write sequences against store.json.
        // Without the write chain, one of these keys silently disappears.
        ctx.store.set("a", 1);
        ctx.store.set("b", 2);
        await new Promise((r) => setTimeout(r, 20));
        ctx.store.set("c", 3);
        ctx.store.set("d", 4);
      }
    `);
    const { plugins } = makeReg();
    await plugins.rescan();
    // The sets enqueue as microtasks/macrotasks behind onEnabled; give the
    // write chain a beat to drain, then read the file the way the next
    // process boot would.
    await new Promise((r) => setTimeout(r, 150));
    const store = JSON.parse(fs.readFileSync(path.join(pdir, "store.json"), "utf8"));
    expect(store).toEqual({ a: 1, b: 2, c: 3, d: 4 });
  });
});
