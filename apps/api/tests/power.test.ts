import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeTestContext, type TestContext } from "./helpers.js";
import { decodeTabString, encodeTabString } from "../src/application/power/power.js";
import { sanitizeHeaders, sanitizeUrl } from "../src/application/netlog/network-logger.js";

/** J7 commands / presets / tab strings and J8 soft reset + network-log privacy. */
const contexts: TestContext[] = [];
afterEach(async () => {
  for (const ctx of contexts.splice(0)) for (const p of ctx.profiles.list()) await ctx.lifecycle.stop(p.id).catch(() => {});
});
const mk = () => {
  const ctx = makeTestContext();
  contexts.push(ctx);
  return ctx;
};

describe("command registry", () => {
  it("lists the catalogue and runs a command per profile through the real routes", async () => {
    const ctx = mk();
    const cat = (await ctx.app.inject({ method: "GET", url: "/commands" })).json().commands as { id: string }[];
    expect(cat.map((c) => c.id)).toContain("tabs.clear-codes");
    const p = ctx.profiles.create({ name: "c", generateFingerprint: true });
    const ok = await ctx.app.inject({ method: "POST", url: "/commands/run", payload: { command: "tabs.clear-codes", profileIds: [p.id] } });
    expect(ok.json().results).toEqual([{ profileId: p.id, ok: true }]);
    // A command that fails reports per profile instead of failing the batch (log-note needs a note).
    const bad = await ctx.app.inject({ method: "POST", url: "/commands/run", payload: { command: "tabs.log-note", profileIds: [p.id] } });
    expect(bad.json().results[0]).toMatchObject({ ok: false });
    expect((await ctx.app.inject({ method: "POST", url: "/commands/run", payload: { command: "nope", profileIds: [p.id] } })).statusCode).toBe(400);
  });
});

describe("preference sets and soft reset", () => {
  it("saves a snapshot without credentials, applies it, and soft reset restores defaults", async () => {
    const ctx = mk();
    await ctx.app.inject({ method: "PATCH", url: "/settings/sections/team", payload: { token: "SECRET-TOKEN", syncPassphrase: "SECRET-PASS" } });
    await ctx.app.inject({ method: "PATCH", url: "/settings/sections/launch", payload: { batchStaggerMs: 750 } });
    expect((await ctx.app.inject({ method: "PUT", url: "/presets/mine" })).json().presets).toEqual(["mine"]);
    const file = fs.readFileSync(path.join(ctx.dataDir, "presets.json"), "utf8");
    expect(file).toContain("750");
    expect(file).not.toContain("SECRET");
    await ctx.app.inject({ method: "PATCH", url: "/settings/sections/launch", payload: { batchStaggerMs: 0 } });
    await ctx.app.inject({ method: "POST", url: "/presets/mine/apply" });
    expect((await ctx.app.inject({ method: "GET", url: "/settings/sections/launch" })).json().batchStaggerMs).toBe(750);
    expect((await ctx.app.inject({ method: "POST", url: "/settings/soft-reset", payload: {} })).statusCode).toBe(400); // needs confirm
    const reset = await ctx.app.inject({ method: "POST", url: "/settings/soft-reset", payload: { confirm: true, sections: ["launch"] } });
    expect(reset.json().launch.batchStaggerMs).toBe(0);
    expect((await ctx.app.inject({ method: "GET", url: "/settings/sections/team" })).json().token).toBe("SECRET-TOKEN"); // untouched section
    expect((await ctx.app.inject({ method: "DELETE", url: "/presets/mine" })).json().presets).toEqual([]);
  });

  it("the ui section stores a label format, a sort and key binds", async () => {
    const ctx = mk();
    const r = await ctx.app.inject({ method: "PATCH", url: "/settings/sections/ui", payload: { tabLabelFormat: "return ctx.email", keybinds: { "tabs.clear-codes": "ctrl+shift+c" } } });
    expect(r.json()).toMatchObject({ tabLabelFormat: "return ctx.email", tabSort: null, keybinds: { "tabs.clear-codes": "ctrl+shift+c" } });
  });
});

describe("tab strings", () => {
  it("round-trip, and only http(s) pages are ever opened", async () => {
    const s = encodeTabString(["https://a.example/x", "file:///c:/secret", "javascript:alert(1)", "http://b.example/"]);
    expect(decodeTabString(s)).toEqual(["https://a.example/x", "http://b.example/"]);
    const evil = `qp1:${Buffer.from(JSON.stringify(["chrome://settings", "data:text/html,x", "https://ok.example/"])).toString("base64url")}`;
    expect(decodeTabString(evil)).toEqual(["https://ok.example/"]);
    expect(() => decodeTabString("nope")).toThrow();
    const ctx = mk();
    const p = ctx.profiles.create({ name: "t", generateFingerprint: true });
    await ctx.lifecycle.start(p.id);
    const opened = await ctx.app.inject({ method: "POST", url: `/profiles/${p.id}/tab-string`, payload: { tabString: s } });
    expect(opened.json()).toEqual({ opened: 2 });
    const gen = (await ctx.app.inject({ method: "GET", url: `/profiles/${p.id}/tab-string` })).json().tabString as string;
    expect(decodeTabString(gen).sort()).toEqual(["http://b.example/", "https://a.example/x"]);
  });
});

describe("network log privacy", () => {
  it("strip drops cookies, auth and query strings; cookies keeps cookies but not auth; everything keeps all", () => {
    const h = { Cookie: "a=b", "Set-Cookie": "c=d", Authorization: "Bearer x", Accept: "*/*" };
    expect(sanitizeHeaders(h, "strip")).toEqual({ Accept: "*/*" });
    expect(sanitizeHeaders({ Referer: "https://a.example/p?token=1" }, "strip")).toEqual({ Referer: "https://a.example/p" });
    expect(sanitizeHeaders(h, "cookies")).toEqual({ Cookie: "a=b", "Set-Cookie": "c=d", Accept: "*/*" });
    expect(sanitizeHeaders(h, "everything")).toEqual(h);
    expect(sanitizeUrl("https://a.example/p?token=1#x", "strip")).toBe("https://a.example/p");
    expect(sanitizeUrl("https://a.example/p?token=1", "everything")).toBe("https://a.example/p?token=1");
  });
});
