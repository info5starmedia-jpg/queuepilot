import { describe, expect, it } from "vitest";
import { ErrorCodes, type LifecycleEvent } from "@queuepilot/contracts";
import type {
  BrowserSession,
  LaunchRequest,
} from "../src/application/runtime/browser-runtime.js";
import { FakeBrowserRuntime } from "../src/application/runtime/fake.browser-runtime.js";
import { makeTestContext } from "./helpers.js";

/** A runtime whose sessions cannot manage tabs (like camoufox today). */
class BareRuntime extends FakeBrowserRuntime {
  override async launch(request: LaunchRequest): Promise<BrowserSession> {
    const s = await super.launch(request);
    return {
      pid: s.pid,
      debugPort: s.debugPort,
      wsEndpoint: s.wsEndpoint,
      exited: s.exited,
      stop: () => s.stop(),
      // deliberately no openTab/closeTab
    };
  }
}

/**
 * Tab & partition model: tabs live inside a run; every tab sits in a session
 * partition; `relatedTo` shares the parent's partition, anything else is
 * isolated. All of it is in-memory and dies with the run.
 */
describe("tabs and partitions", () => {
  it("a tab opened without relatedTo gets its own isolated partition", async () => {
    const { lifecycle, profiles } = makeTestContext();
    const p = profiles.create({ name: "tabs-1", generateFingerprint: true });
    await lifecycle.start(p.id);

    const a = await lifecycle.openTab(p.id, { url: "https://a.example" });
    const b = await lifecycle.openTab(p.id, { url: "https://b.example" });

    expect(a.status).toBe("open");
    expect(a.partitionId).not.toBe(b.partitionId);
    expect(a.relatedToTabId).toBeNull();

    const { tabs, partitions } = lifecycle.listTabs(p.id);
    expect(tabs).toHaveLength(2);
    expect(partitions).toHaveLength(2);

    await lifecycle.stop(p.id);
  });

  it("a related tab shares the parent's partition and records the relation", async () => {
    const { lifecycle, profiles, runtime } = makeTestContext();
    const p = profiles.create({ name: "tabs-2", generateFingerprint: true });
    await lifecycle.start(p.id);

    const parent = await lifecycle.openTab(p.id, {
      url: "https://shop.example",
    });
    const child = await lifecycle.openTab(p.id, {
      url: "https://shop.example/cart",
      relatedTo: parent.id,
    });

    expect(child.partitionId).toBe(parent.partitionId);
    expect(child.relatedToTabId).toBe(parent.id);

    // The engine was asked to route both tabs into the same partition.
    const session = runtime.sessions[0];
    expect(session).toBeDefined();
    const keys = [...session!.tabs.values()].map((t) => t.partitionKey);
    expect(new Set(keys).size).toBe(1);

    const { partitions } = lifecycle.listTabs(p.id);
    expect(partitions).toHaveLength(1);

    await lifecycle.stop(p.id);
  });

  it("refuses relatedTo across runs — sessions never leak across profiles", async () => {
    const { lifecycle, profiles } = makeTestContext();
    const a = profiles.create({ name: "tabs-a", generateFingerprint: true });
    const b = profiles.create({ name: "tabs-b", generateFingerprint: true });
    await lifecycle.start(a.id);
    await lifecycle.start(b.id);

    const tabA = await lifecycle.openTab(a.id, {});
    await expect(
      lifecycle.openTab(b.id, { relatedTo: tabA.id }),
    ).rejects.toMatchObject({ code: ErrorCodes.TAB_NOT_FOUND });

    await lifecycle.stop(a.id);
    await lifecycle.stop(b.id);
  });

  it("refuses relatedTo a closed tab", async () => {
    const { lifecycle, profiles } = makeTestContext();
    const p = profiles.create({
      name: "tabs-closed",
      generateFingerprint: true,
    });
    await lifecycle.start(p.id);

    const tab = await lifecycle.openTab(p.id, {});
    await lifecycle.closeTab(p.id, tab.id);
    await expect(
      lifecycle.openTab(p.id, { relatedTo: tab.id }),
    ).rejects.toMatchObject({
      code: ErrorCodes.TAB_NOT_FOUND,
    });

    await lifecycle.stop(p.id);
  });

  it("close is idempotent and emits tab.opened / tab.closed events", async () => {
    const { lifecycle, profiles } = makeTestContext();
    const events: LifecycleEvent[] = [];
    lifecycle.events.on("lifecycle", (e: LifecycleEvent) => events.push(e));

    const p = profiles.create({
      name: "tabs-events",
      generateFingerprint: true,
    });
    await lifecycle.start(p.id);
    const tab = await lifecycle.openTab(p.id, { url: "https://x.example" });

    const first = await lifecycle.closeTab(p.id, tab.id);
    expect(first.status).toBe("closed");
    expect(first.closedAt).not.toBeNull();
    const second = await lifecycle.closeTab(p.id, tab.id);
    expect(second.status).toBe("closed");

    const kinds = events.map((e) => e.type);
    expect(kinds).toContain("tab.opened");
    expect(kinds.filter((t) => t === "tab.closed")).toHaveLength(1);
    const opened = events.find((e) => e.type === "tab.opened");
    expect(opened?.tabId).toBe(tab.id);

    await lifecycle.stop(p.id);
  });

  it("tab state dies with the run", async () => {
    const { lifecycle, profiles } = makeTestContext();
    const p = profiles.create({ name: "tabs-die", generateFingerprint: true });
    await lifecycle.start(p.id);
    await lifecycle.openTab(p.id, {});
    await lifecycle.openTab(p.id, {});
    expect(lifecycle.listTabs(p.id).tabs).toHaveLength(2);

    await lifecycle.stop(p.id);
    expect(lifecycle.listTabs(p.id).tabs).toHaveLength(0);
    expect(lifecycle.listTabs(p.id).partitions).toHaveLength(0);
  });

  it("opening a tab with no active run is PROFILE_NOT_RUNNING", async () => {
    const { lifecycle, profiles } = makeTestContext();
    const p = profiles.create({
      name: "tabs-norun",
      generateFingerprint: true,
    });
    await expect(lifecycle.openTab(p.id, {})).rejects.toMatchObject({
      code: ErrorCodes.PROFILE_NOT_RUNNING,
    });
  });

  it("a runtime without tab support answers TABS_UNSUPPORTED, not a fake tab", async () => {
    const { lifecycle, profiles } = makeTestContext(new BareRuntime());
    const p = profiles.create({ name: "tabs-bare", generateFingerprint: true });
    await lifecycle.start(p.id);

    await expect(lifecycle.openTab(p.id, {})).rejects.toMatchObject({
      code: ErrorCodes.TABS_UNSUPPORTED,
    });

    await lifecycle.stop(p.id);
  });

  it("HTTP: full tab flow over the API", async () => {
    const { app, profiles, lifecycle } = makeTestContext();
    const p = profiles.create({ name: "tabs-http", generateFingerprint: true });
    await lifecycle.start(p.id);

    const created = await app.inject({
      method: "POST",
      url: `/profiles/${p.id}/tabs`,
      payload: { url: "https://http.example" },
    });
    expect(created.statusCode).toBe(201);
    const tab = created.json();

    const related = await app.inject({
      method: "POST",
      url: `/profiles/${p.id}/tabs`,
      payload: { relatedTo: tab.id },
    });
    expect(related.statusCode).toBe(201);
    expect(related.json().partitionId).toBe(tab.partitionId);

    const listed = await app.inject({
      method: "GET",
      url: `/profiles/${p.id}/tabs`,
    });
    expect(listed.json().tabs).toHaveLength(2);
    expect(listed.json().partitions).toHaveLength(1);

    const closed = await app.inject({
      method: "POST",
      url: `/profiles/${p.id}/tabs/${tab.id}/close`,
    });
    expect(closed.json().closed).toBe(true);

    const missing = await app.inject({
      method: "POST",
      url: `/profiles/${p.id}/tabs/00000000-0000-0000-0000-000000000000/close`,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("TAB_NOT_FOUND");

    await lifecycle.stop(p.id);
  });

  it("HTTP: rejects invalid input and reports unsupported runtimes correctly", async () => {
    const { app, profiles, lifecycle } = makeTestContext();
    const p = profiles.create({
      name: "tabs-http-err",
      generateFingerprint: true,
    });

    // No run -> 409 PROFILE_NOT_RUNNING
    const noRun = await app.inject({
      method: "POST",
      url: `/profiles/${p.id}/tabs`,
      payload: {},
    });
    expect(noRun.statusCode).toBe(409);
    expect(noRun.json().error.code).toBe("PROFILE_NOT_RUNNING");

    await lifecycle.start(p.id);
    // Bad url -> 400
    const bad = await app.inject({
      method: "POST",
      url: `/profiles/${p.id}/tabs`,
      payload: { url: "not-a-url" },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe("VALIDATION_FAILED");

    await lifecycle.stop(p.id);
  });

  it("HTTP: 501 TABS_UNSUPPORTED from a runtime that cannot manage tabs", async () => {
    const { app, profiles, lifecycle } = makeTestContext(new BareRuntime());
    const p = profiles.create({ name: "tabs-501", generateFingerprint: true });
    await lifecycle.start(p.id);

    const res = await app.inject({
      method: "POST",
      url: `/profiles/${p.id}/tabs`,
      payload: {},
    });
    expect(res.statusCode).toBe(501);
    expect(res.json().error.code).toBe("TABS_UNSUPPORTED");

    await lifecycle.stop(p.id);
  });
});
