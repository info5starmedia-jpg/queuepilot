import { afterEach, describe, expect, it, vi } from "vitest";
import { CdpTabController } from "../src/application/runtime/cdp/cdp-tab-controller.js";
import { makeTestContext, type TestContext } from "./helpers.js";
import { MockCdpServer } from "./helpers/mock-cdp-server.js";

/**
 * Tab-ops depth (Phase 2): per-tab reload, auto-reload, duplicate and
 * screenshot. API behaviour runs on the fake runtime; the CDP wiring the
 * real engines use is checked against the mock DevTools server.
 */

const contexts: TestContext[] = [];
afterEach(async () => {
  for (const ctx of contexts.splice(0)) {
    for (const p of ctx.profiles.list?.() ?? []) await ctx.lifecycle.stop(p.id).catch(() => {});
  }
});

async function runningWithTab(url = "https://example.com/queue") {
  const ctx = makeTestContext();
  contexts.push(ctx);
  const p = ctx.profiles.create({ name: "tabs", generateFingerprint: true });
  await ctx.lifecycle.start(p.id);
  const opened = await ctx.app.inject({ method: "POST", url: `/profiles/${p.id}/tabs`, payload: { url } });
  const tab = opened.json() as { id: string; engineTabId: string; partitionId: string };
  return { ctx, profileId: p.id, tab, session: ctx.runtime.sessions.at(-1)! };
}

describe("tab ops over the API", () => {
  it("reload reaches the engine tab", async () => {
    const { ctx, profileId, tab, session } = await runningWithTab();
    const res = await ctx.app.inject({ method: "POST", url: `/profiles/${profileId}/tabs/${tab.id}/reload` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ reloaded: true, tab: { id: tab.id } });
    expect(session.reloads.get(tab.engineTabId)).toBe(1);
  });

  it("duplicate opens the same URL in the SAME session partition", async () => {
    const { ctx, profileId, tab, session } = await runningWithTab();
    const res = await ctx.app.inject({ method: "POST", url: `/profiles/${profileId}/tabs/${tab.id}/duplicate` });
    expect(res.statusCode).toBe(201);
    const copy = res.json() as { id: string; url: string; partitionId: string; relatedToTabId: string; engineTabId: string };
    expect(copy.id).not.toBe(tab.id);
    expect(copy.url).toBe("https://example.com/queue");
    expect(copy.partitionId).toBe(tab.partitionId);
    expect(copy.relatedToTabId).toBe(tab.id);
    // Engine side: the copy was routed into the original's partition key.
    expect(session.tabs.get(copy.engineTabId)?.partitionKey).toBe(session.tabs.get(tab.engineTabId)?.partitionKey);
  });

  it("screenshot returns a PNG", async () => {
    const { ctx, profileId, tab } = await runningWithTab();
    const res = await ctx.app.inject({ method: "GET", url: `/profiles/${profileId}/tabs/${tab.id}/screenshot` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^image\/png/);
    expect(res.rawPayload.subarray(1, 4).toString("latin1")).toBe("PNG");
  });

  it("auto-reload fires on its interval, shows in the tab list, and stops when turned off", async () => {
    const { ctx, profileId, tab, session } = await runningWithTab();
    ctx.lifecycle["autoReloadUnitMs"] = 10; // 5 "s" = 50 ms
    const on = await ctx.app.inject({
      method: "POST",
      url: `/profiles/${profileId}/tabs/${tab.id}/auto-reload`,
      payload: { intervalSec: 5 },
    });
    expect(on.json().tab.autoReloadSec).toBe(5);
    await vi.waitFor(() => expect(session.reloads.get(tab.engineTabId) ?? 0).toBeGreaterThanOrEqual(2));
    const listed = (await ctx.app.inject({ method: "GET", url: `/profiles/${profileId}/tabs` })).json();
    expect(listed.tabs.find((t: { id: string }) => t.id === tab.id).autoReloadSec).toBe(5);

    await ctx.app.inject({ method: "POST", url: `/profiles/${profileId}/tabs/${tab.id}/auto-reload`, payload: { intervalSec: 0 } });
    const after = session.reloads.get(tab.engineTabId) ?? 0;
    await new Promise((r) => setTimeout(r, 200));
    expect(session.reloads.get(tab.engineTabId)).toBe(after);
    const relisted = (await ctx.app.inject({ method: "GET", url: `/profiles/${profileId}/tabs` })).json();
    expect(relisted.tabs.find((t: { id: string }) => t.id === tab.id).autoReloadSec).toBeUndefined();
  });

  it("auto-reload dies with the tab and with the run", async () => {
    const { ctx, profileId, tab } = await runningWithTab();
    ctx.lifecycle["autoReloadUnitMs"] = 10;
    await ctx.app.inject({ method: "POST", url: `/profiles/${profileId}/tabs/${tab.id}/auto-reload`, payload: { intervalSec: 5 } });
    await ctx.app.inject({ method: "POST", url: `/profiles/${profileId}/tabs/${tab.id}/close` });
    expect(ctx.lifecycle["autoReloads"].size).toBe(0);

    const second = await ctx.app.inject({ method: "POST", url: `/profiles/${profileId}/tabs`, payload: { url: "https://example.com/2" } });
    await ctx.app.inject({ method: "POST", url: `/profiles/${profileId}/tabs/${second.json().id}/auto-reload`, payload: { intervalSec: 5 } });
    expect(ctx.lifecycle["autoReloads"].size).toBe(1);
    await ctx.lifecycle.stop(profileId);
    expect(ctx.lifecycle["autoReloads"].size).toBe(0);
  });

  it("validates the interval and refuses closed tabs and stopped profiles", async () => {
    const { ctx, profileId, tab } = await runningWithTab();
    for (const intervalSec of [1, 4, 3601, -5, 2.5]) {
      const bad = await ctx.app.inject({ method: "POST", url: `/profiles/${profileId}/tabs/${tab.id}/auto-reload`, payload: { intervalSec } });
      expect(bad.statusCode, `intervalSec=${intervalSec}`).toBe(400);
    }
    await ctx.app.inject({ method: "POST", url: `/profiles/${profileId}/tabs/${tab.id}/close` });
    const closed = await ctx.app.inject({ method: "POST", url: `/profiles/${profileId}/tabs/${tab.id}/reload` });
    expect(closed.statusCode).toBe(409);
    await ctx.lifecycle.stop(profileId);
    const stopped = await ctx.app.inject({ method: "GET", url: `/profiles/${profileId}/tabs/${tab.id}/screenshot` });
    expect(stopped.statusCode).toBe(409);
  });
});

describe("CdpTabController tab ops (the real-engine path)", () => {
  it("reload and screenshot go to an ATTACHED page session and always detach", async () => {
    const cdp = new MockCdpServer();
    const { wsUrl } = await cdp.start();
    const tabs = new CdpTabController(wsUrl);
    try {
      const { engineTabId } = await tabs.openTab("https://example.com/", "p1");
      await tabs.reloadTab(engineTabId);
      const png = await tabs.screenshotTab(engineTabId);

      expect(png.toString()).toBe("mock-png");
      const attaches = cdp.callsFor("Target.attachToTarget");
      expect(attaches).toHaveLength(2);
      expect(attaches[0]!.params).toMatchObject({ targetId: engineTabId, flatten: true });
      expect(cdp.callsFor("Target.detachFromTarget")).toHaveLength(2);
      // Page.* calls carried the session id (never the browser-level socket).
      for (const m of ["Page.reload", "Page.captureScreenshot"]) {
        const [call] = cdp.callsFor(m);
        expect(call, m).toBeTruthy();
        expect(call!.sessionId, m).toMatch(/^session-/);
      }
    } finally {
      await tabs.dispose();
      await cdp.stop();
    }
  });
});
