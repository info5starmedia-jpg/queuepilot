import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeTestContext, type TestContext } from "./helpers.js";

/** J3b — change URL with focus delay, sequential / hard reload, reopen, export tabs, log note. */
const contexts: TestContext[] = [];
afterEach(async () => {
  for (const ctx of contexts.splice(0)) for (const p of ctx.profiles.list()) await ctx.lifecycle.stop(p.id).catch(() => {});
});

async function running(urls: string[]) {
  const ctx = makeTestContext();
  contexts.push(ctx);
  const p = ctx.profiles.create({ name: "tabs", email: "t@example.com", generateFingerprint: true });
  await ctx.lifecycle.start(p.id);
  const tabs: { id: string; engineTabId: string }[] = [];
  for (const url of urls) tabs.push((await ctx.app.inject({ method: "POST", url: `/profiles/${p.id}/tabs`, payload: { url } })).json());
  return { ctx, id: p.id, tabs, session: ctx.runtime.sessions.at(-1)! };
}
const post = (ctx: TestContext, url: string, payload: unknown) => ctx.app.inject({ method: "POST", url, payload: payload as object });

describe("J3b tab commands", () => {
  it("change URL focuses (after the focus delay) then navigates, in order; a bad tab doesn't stop the rest", async () => {
    const { ctx, id, tabs, session } = await running(["https://example.com/a", "https://example.com/b"]);
    const res = await post(ctx, `/profiles/${id}/tabs/change-url`, {
      items: [
        { tabId: tabs[0]!.id, url: "https://example.com/x" },
        { tabId: "11111111-1111-4111-8111-111111111111", url: "https://example.com/missing" },
        { tabId: tabs[1]!.id, url: "https://example.com/y" },
      ],
      focusDelayMs: 1,
      delayMs: 1,
    });
    const results = res.json().results as { ok: boolean }[];
    expect(results.map((r) => r.ok)).toEqual([true, false, true]);
    expect(session.tabCalls).toEqual([
      `focus ${tabs[0]!.engineTabId}`,
      `navigate ${tabs[0]!.engineTabId} https://example.com/x`,
      `focus ${tabs[1]!.engineTabId}`,
      `navigate ${tabs[1]!.engineTabId} https://example.com/y`,
    ]);
  });

  it("no focus delay (-1) navigates without bringing the tab forward", async () => {
    const { ctx, id, tabs, session } = await running(["https://example.com/a"]);
    await post(ctx, `/profiles/${id}/tabs/change-url`, { items: [{ tabId: tabs[0]!.id, url: "https://example.com/z" }] });
    expect(session.tabCalls).toEqual([`navigate ${tabs[0]!.engineTabId} https://example.com/z`]);
  });

  it("sequential hard reload reloads every tab with ignoreCache", async () => {
    const { ctx, id, tabs, session } = await running(["https://example.com/a", "https://example.com/b"]);
    const res = await post(ctx, `/profiles/${id}/tabs/reload-sequence`, { tabIds: tabs.map((t) => t.id), hard: true, delayMs: 1 });
    expect(res.json().results.every((r: { ok: boolean }) => r.ok)).toBe(true);
    for (const t of tabs) expect(session.hardReloads.get(t.engineTabId)).toBe(1);
    await post(ctx, `/profiles/${id}/tabs/${tabs[0]!.id}/reload`, {});
    expect(session.hardReloads.get(tabs[0]!.engineTabId)).toBe(1); // a plain reload stays soft
  });

  it("reopen brings back the most recently closed tabs, newest first", async () => {
    const { ctx, id, tabs } = await running(["https://example.com/a", "https://example.com/b"]);
    await post(ctx, `/profiles/${id}/tabs/${tabs[0]!.id}/close`, {});
    await new Promise((r) => setTimeout(r, 5));
    await post(ctx, `/profiles/${id}/tabs/${tabs[1]!.id}/close`, {});
    const first = (await post(ctx, `/profiles/${id}/tabs/reopen`, {})).json().tab as { url: string };
    expect(first.url).toBe("https://example.com/b");
    const second = (await post(ctx, `/profiles/${id}/tabs/reopen`, {})).json().tab as { url: string };
    expect(second.url).toBe("https://example.com/a");
    expect((await post(ctx, `/profiles/${id}/tabs/reopen`, {})).statusCode).toBe(409);
  });

  it("export lists open tabs as formula-safe CSV; log-note appends to notes-log.csv", async () => {
    const { ctx, id } = await running(["https://example.com/a"]);
    const csv = (await post(ctx, "/tabs/export", { profileIds: [id] })).body;
    expect(csv).toContain("profile,email,tabId,url,openedAt");
    expect(csv).toContain("t@example.com");
    expect(csv).toContain("https://example.com/a");
    expect((await post(ctx, `/profiles/${id}/log-note`, { note: "=cmd|' /C calc'!A0" })).json()).toEqual({ logged: true });
    const log = fs.readFileSync(path.join(ctx.dataDir, "notes-log.csv"), "utf8");
    expect(log).toContain("'=cmd");
    expect(log.startsWith("time,profile,email,note")).toBe(true);
  });
});
