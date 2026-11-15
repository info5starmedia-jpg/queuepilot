import { describe, expect, it } from "vitest";
import { type BrowserTab } from "@queuepilot/contracts";
import { compileTabQuery, filterTabs, sortTabs } from "../src/application/tabs/tab-thinger.js";
import { makeTestContext } from "./helpers.js";

/**
 * Tab Thinger (v0.14.8): Jancy's formula query language over tabs —
 * `[!]field:pattern` tokens ANDed, `*` wildcards, bare tokens = url sugar.
 */

function tab(over: Partial<BrowserTab>): BrowserTab {
  return {
    id: over.id ?? "11111111-1111-4111-8111-111111111111",
    runId: "22222222-2222-4222-8222-222222222222",
    profileId: "33333333-3333-4333-8333-333333333333",
    partitionId: over.partitionId ?? "44444444-4444-4444-8444-444444444444",
    engineTabId: over.engineTabId === undefined ? "engine-1" : over.engineTabId,
    url: over.url === undefined ? "https://shop.example/checkout" : over.url,
    relatedToTabId: over.relatedToTabId === undefined ? null : over.relatedToTabId,
    status: over.status ?? "open",
    createdAt: over.createdAt ?? "2026-11-15T00:00:00.000Z",
    closedAt: over.closedAt === undefined ? null : over.closedAt,
  };
}

const TABS: BrowserTab[] = [
  tab({ id: "aaaaaaaa-0000-4000-8000-000000000001", url: "https://shop.example/checkout" }),
  tab({
    id: "aaaaaaaa-0000-4000-8000-000000000002",
    url: "https://mail.example.com/inbox",
    status: "closed",
    closedAt: "2026-11-15T00:05:00.000Z",
    engineTabId: null,
  }),
  tab({
    id: "aaaaaaaa-0000-4000-8000-000000000003",
    url: "https://shop.example/cart",
    relatedToTabId: "aaaaaaaa-0000-4000-8000-000000000001",
    partitionId: "55555555-5555-4555-8555-555555555555",
  }),
];

describe("compileTabQuery / filterTabs", () => {
  it("empty query matches everything", () => {
    expect(filterTabs(TABS, "")).toHaveLength(3);
    expect(filterTabs(TABS, "   ")).toHaveLength(3);
  });

  it("status and exact-value matching", () => {
    expect(filterTabs(TABS, "status:closed").map((t) => t.url)).toEqual([
      "https://mail.example.com/inbox",
    ]);
    expect(filterTabs(TABS, "status:open")).toHaveLength(2);
  });

  it("url wildcards and bare-token sugar", () => {
    expect(filterTabs(TABS, "url:*shop*")).toHaveLength(2);
    expect(filterTabs(TABS, "checkout")).toHaveLength(1);
    expect(filterTabs(TABS, "url:*.example.com*")).toHaveLength(1);
  });

  it("negation", () => {
    expect(filterTabs(TABS, "status:open !url:*shop*")).toHaveLength(0);
    expect(filterTabs(TABS, "!url:*shop*")).toHaveLength(1);
  });

  it("related / engine pseudo-fields", () => {
    expect(filterTabs(TABS, "related:yes").map((t) => t.url)).toEqual([
      "https://shop.example/cart",
    ]);
    expect(filterTabs(TABS, "engine:no")).toHaveLength(1);
  });

  it("partition prefix matching", () => {
    expect(filterTabs(TABS, "partition:55555555")).toHaveLength(1);
    expect(filterTabs(TABS, "partition:66666666")).toHaveLength(0);
  });

  it("AND semantics across tokens", () => {
    expect(filterTabs(TABS, "status:open url:*checkout*")).toHaveLength(1);
    expect(filterTabs(TABS, "status:closed url:*checkout*")).toHaveLength(0);
  });

  it("unknown fields and empty patterns refuse loudly", () => {
    expect(() => compileTabQuery("bogus:yes")).toThrow(/unknown tab query field/);
    expect(() => compileTabQuery("url:")).toThrow(/empty pattern/);
  });
});

describe("Tab Thinger + bulk ops over HTTP", () => {
  it("query endpoint filters a live run's tabs", async () => {
    const { app, lifecycle, profiles } = makeTestContext();
    const p = profiles.create({ name: "thinger-1", generateFingerprint: true });
    await lifecycle.start(p.id);
    await lifecycle.openTab(p.id, { url: "https://shop.example/checkout" });
    await lifecycle.openTab(p.id, { url: "https://news.example.com" });

    const res = await app.inject({
      method: "POST",
      url: `/profiles/${p.id}/tabs/query`,
      payload: { q: "url:*shop*" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().tabs).toHaveLength(1);
    expect(res.json().tabs[0].url).toBe("https://shop.example/checkout");

    const all = await app.inject({
      method: "POST",
      url: `/profiles/${p.id}/tabs/query`,
      payload: {},
    });
    expect(all.json().tabs).toHaveLength(2);

    const bad = await app.inject({
      method: "POST",
      url: `/profiles/${p.id}/tabs/query`,
      payload: { q: "bogus:x" },
    });
    expect(bad.statusCode).toBe(400);

    await lifecycle.stop(p.id);
  });

  it("bulk-close by query closes the matching set and reports per-tab", async () => {
    const { app, lifecycle, profiles } = makeTestContext();
    const p = profiles.create({ name: "thinger-2", generateFingerprint: true });
    await lifecycle.start(p.id);
    const a = await lifecycle.openTab(p.id, { url: "https://shop.example/checkout" });
    await lifecycle.openTab(p.id, { url: "https://news.example.com" });

    const res = await app.inject({
      method: "POST",
      url: `/profiles/${p.id}/tabs/bulk-close`,
      payload: { q: "url:*shop*" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(1);
    expect(res.json().results[0]).toEqual({ tabId: a.id, closed: true });
    expect(lifecycle.listTabs(p.id).tabs.filter((t) => t.status === "open")).toHaveLength(1);

    await lifecycle.stop(p.id);
  });

  it("bulk-close by explicit tabIds is idempotent for already-closed tabs", async () => {
    const { app, lifecycle, profiles } = makeTestContext();
    const p = profiles.create({ name: "thinger-3", generateFingerprint: true });
    await lifecycle.start(p.id);
    const a = await lifecycle.openTab(p.id, { url: "https://a.example" });
    await lifecycle.closeTab(p.id, a.id);

    const res = await app.inject({
      method: "POST",
      url: `/profiles/${p.id}/tabs/bulk-close`,
      payload: { tabIds: [a.id] },
    });
    expect(res.json().results[0]).toEqual({ tabId: a.id, closed: true });

    await lifecycle.stop(p.id);
  });

  it("bulk-close requires tabIds or q", async () => {
    const { app, profiles } = makeTestContext();
    const p = profiles.create({ name: "thinger-4", generateFingerprint: true });
    const res = await app.inject({
      method: "POST",
      url: `/profiles/${p.id}/tabs/bulk-close`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("bulk-open opens every URL and reports per-url", async () => {
    const { app, lifecycle, profiles } = makeTestContext();
    const p = profiles.create({ name: "thinger-5", generateFingerprint: true });
    await lifecycle.start(p.id);

    const res = await app.inject({
      method: "POST",
      url: `/profiles/${p.id}/tabs/bulk-open`,
      payload: { urls: ["https://a.example", "https://b.example"] },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().total).toBe(2);
    expect(res.json().results.every((r: { tab: unknown }) => r.tab !== null)).toBe(true);
    expect(lifecycle.listTabs(p.id).tabs).toHaveLength(2);

    await lifecycle.stop(p.id);
  });
});

describe("sortTabs (v0.14.12)", () => {
  it("sorts a copy by each mode without mutating the input", () => {
    const mixed = [
      tab({ id: "aaaaaaaa-0000-4000-8000-000000000010", url: "https://zeta.example.com", createdAt: "2026-11-15T00:03:00.000Z", status: "open" }),
      tab({ id: "aaaaaaaa-0000-4000-8000-000000000011", url: "https://alpha.example.com/b", createdAt: "2026-11-15T00:01:00.000Z", status: "closed", closedAt: "2026-11-15T00:04:00.000Z" }),
      tab({ id: "aaaaaaaa-0000-4000-8000-000000000012", url: "https://alpha.example.com/a", createdAt: "2026-11-15T00:02:00.000Z", status: "open", partitionId: "55555555-5555-4555-8555-555555555555" }),
    ];
    const original = [...mixed];

    expect(sortTabs(mixed, "url").map((t) => t.url)).toEqual([
      "https://alpha.example.com/a",
      "https://alpha.example.com/b",
      "https://zeta.example.com",
    ]);
    expect(sortTabs(mixed, "domain").map((t) => t.url)).toEqual([
      "https://alpha.example.com/a",
      "https://alpha.example.com/b",
      "https://zeta.example.com",
    ]);
    expect(sortTabs(mixed, "newest").map((t) => t.id)).toEqual([
      "aaaaaaaa-0000-4000-8000-000000000010",
      "aaaaaaaa-0000-4000-8000-000000000012",
      "aaaaaaaa-0000-4000-8000-000000000011",
    ]);
    expect(sortTabs(mixed, "oldest").map((t) => t.id)).toEqual([
      "aaaaaaaa-0000-4000-8000-000000000011",
      "aaaaaaaa-0000-4000-8000-000000000012",
      "aaaaaaaa-0000-4000-8000-000000000010",
    ]);
    expect(sortTabs(mixed, "status")[0]!.status).toBe("closed");
    expect(sortTabs(mixed, "partition")[2]!.partitionId).toBe("55555555-5555-4555-8555-555555555555");
    expect(mixed).toEqual(original); // input untouched
  });
});

describe("tab sort + stagger over HTTP (v0.14.12)", () => {
  it("GET tabs honors ?sort= and refuses an unknown mode", async () => {
    const { app, lifecycle, profiles } = makeTestContext();
    const p = profiles.create({ name: "sort-1", generateFingerprint: true });
    await lifecycle.start(p.id);
    await lifecycle.openTab(p.id, { url: "https://z.example" });
    await lifecycle.openTab(p.id, { url: "https://a.example" });

    const res = await app.inject({ method: "GET", url: `/profiles/${p.id}/tabs?sort=url` });
    expect(res.statusCode).toBe(200);
    expect(res.json().tabs.map((t: { url: string }) => t.url)).toEqual([
      "https://a.example",
      "https://z.example",
    ]);

    const bad = await app.inject({ method: "GET", url: `/profiles/${p.id}/tabs?sort=bogus` });
    expect(bad.statusCode).toBe(400);

    await lifecycle.stop(p.id);
  });

  it("query accepts a sort, bulk-open honors staggerMs between opens", async () => {
    const { app, lifecycle, profiles } = makeTestContext();
    const p = profiles.create({ name: "sort-2", generateFingerprint: true });
    await lifecycle.start(p.id);
    await lifecycle.openTab(p.id, { url: "https://z.example" });
    await lifecycle.openTab(p.id, { url: "https://a.example" });

    const q = await app.inject({
      method: "POST",
      url: `/profiles/${p.id}/tabs/query`,
      payload: { q: "", sort: "url" },
    });
    expect(q.json().tabs.map((t: { url: string }) => t.url)).toEqual([
      "https://a.example",
      "https://z.example",
    ]);

    const before = Date.now();
    const bulk = await app.inject({
      method: "POST",
      url: `/profiles/${p.id}/tabs/bulk-open`,
      payload: {
        urls: ["https://one.example", "https://two.example", "https://three.example"],
        staggerMs: 40,
      },
    });
    const elapsed = Date.now() - before;
    expect(bulk.statusCode).toBe(201);
    expect(bulk.json().total).toBe(3);
    expect(elapsed).toBeGreaterThanOrEqual(80); // two inter-open gaps

    await lifecycle.stop(p.id);
  });
});
