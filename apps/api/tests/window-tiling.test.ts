import { describe, expect, it, afterEach } from "vitest";
import { makeTestContext } from "./helpers.js";
import { MockCdpServer } from "./helpers/mock-cdp-server.js";
import { FakeBrowserRuntime } from "../src/application/runtime/fake.browser-runtime.js";
import { cascadeRects, gridRects, tileRects } from "../src/application/windows/window-tiling.service.js";

let server: MockCdpServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

async function ctxWithMockCdp() {
  server = new MockCdpServer();
  const { wsUrl } = await server.start();
  const runtime = new FakeBrowserRuntime();
  runtime.nextWsEndpoint = wsUrl;
  return makeTestContext(runtime);
}

describe("tiling rect math", () => {
  const area = { left: 0, top: 0, width: 1920, height: 1040 };

  it("cascade stair-steps and clamps at the work-area edge", () => {
    const rects = cascadeRects(3, area);
    expect(rects[0]).toEqual({ left: 0, top: 0, width: 1152, height: 728 });
    expect(rects[1]!.left).toBe(32);
    expect(rects[1]!.top).toBe(24);
    // Far enough along, the offset clamps so the window never leaves the area
    const many = cascadeRects(500, area);
    for (const r of many) {
      expect(r.left + r.width).toBeLessThanOrEqual(area.width);
      expect(r.top + r.height).toBeLessThanOrEqual(area.height);
    }
  });

  it("grid splits into square-ish cells inside the area", () => {
    const rects = gridRects(4, area, { margin: 8 });
    expect(rects).toHaveLength(4);
    for (const r of rects) {
      expect(r.left).toBeGreaterThanOrEqual(area.left);
      expect(r.top).toBeGreaterThanOrEqual(area.top);
      expect(r.left + r.width).toBeLessThanOrEqual(area.width);
      expect(r.top + r.height).toBeLessThanOrEqual(area.height);
    }
    // 4 windows on a wide 1920x1040 area -> 3 cols x 2 rows
    expect(rects[1]!.left).toBeGreaterThan(rects[0]!.left); // next column
    expect(rects[3]!.top).toBeGreaterThan(rects[0]!.top); // second row
  });

  it("tileRects dispatches on preset", () => {
    const area = { left: 0, top: 0, width: 1000, height: 800 };
    expect(tileRects("cascade", 2, area)).toEqual(cascadeRects(2, area));
    expect(tileRects("grid", 2, area)).toEqual(gridRects(2, area));
  });
});

describe("window tiling API", () => {
  it("POST /profiles/:id/window/bounds moves the window and remembers it", async () => {
    const ctx = await ctxWithMockCdp();
    const p = ctx.profiles.create({ name: "win-1", generateFingerprint: true });
    await ctx.app.inject({ method: "POST", url: `/profiles/${p.id}/start`, payload: {} });

    const bounds = { left: 100, top: 60, width: 1200, height: 800 };
    const res = await ctx.app.inject({
      method: "POST",
      url: `/profiles/${p.id}/window/bounds`,
      payload: { bounds },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "tiled", applied: bounds });
    expect(server!.setWindowBoundsCalls).toHaveLength(1);
    expect(server!.setWindowBoundsCalls[0]).toMatchObject({ bounds: { ...bounds, windowState: "normal" } });
    // remembered on the persona bag
    expect(ctx.profiles.get(p.id).extra?.windowBounds).toEqual(bounds);
  });

  it("batch-tile cascades running profiles and fails not-running rows", async () => {
    const ctx = await ctxWithMockCdp();
    const a = ctx.profiles.create({ name: "win-a", generateFingerprint: true });
    const b = ctx.profiles.create({ name: "win-b", generateFingerprint: true });
    await ctx.app.inject({ method: "POST", url: `/profiles/${a.id}/start`, payload: {} });
    await ctx.app.inject({ method: "POST", url: `/profiles/${b.id}/start`, payload: {} });

    const area = { left: 0, top: 0, width: 1920, height: 1040 };
    const res = await ctx.app.inject({
      method: "POST",
      url: "/profiles/batch-tile",
      payload: { ids: [a.id, b.id, "no-such"], preset: "grid", area },
    });
    expect(res.statusCode).toBe(200);
    const { results } = res.json();
    expect(results[0]).toMatchObject({ id: a.id, status: "tiled" });
    expect(results[1]).toMatchObject({ id: b.id, status: "tiled" });
    expect(results[2]).toMatchObject({ id: "no-such", status: "failed" });
    // two distinct grid cells applied
    expect(results[0].applied.left).not.toBe(results[1].applied.left);
    // remembered per profile
    expect(ctx.profiles.get(a.id).extra?.windowBounds).toEqual(results[0].applied);
  });

  it("batch-window-restore puts a restarted profile back where it was", async () => {
    const ctx = await ctxWithMockCdp();
    const p = ctx.profiles.create({ name: "win-r", generateFingerprint: true });
    await ctx.app.inject({ method: "POST", url: `/profiles/${p.id}/start`, payload: {} });
    const bounds = { left: 220, top: 140, width: 1100, height: 760 };
    await ctx.app.inject({
      method: "POST",
      url: `/profiles/${p.id}/window/bounds`,
      payload: { bounds },
    });
    // restart: the remembered geometry should survive
    await ctx.app.inject({ method: "POST", url: `/profiles/${p.id}/stop` });
    await ctx.app.inject({ method: "POST", url: `/profiles/${p.id}/start`, payload: {} });

    server!.setWindowBoundsCalls.length = 0;
    const res = await ctx.app.inject({
      method: "POST",
      url: "/profiles/batch-window-restore",
      payload: { ids: [p.id] },
    });
    expect(res.json().results[0]).toMatchObject({ status: "tiled", applied: bounds });
    expect(server!.setWindowBoundsCalls).toHaveLength(1);
  });

  it("a profile with no remembered bounds fails its restore row", async () => {
    const ctx = await ctxWithMockCdp();
    const p = ctx.profiles.create({ name: "win-none", generateFingerprint: true });
    await ctx.app.inject({ method: "POST", url: `/profiles/${p.id}/start`, payload: {} });
    const res = await ctx.app.inject({
      method: "POST",
      url: "/profiles/batch-window-restore",
      payload: { ids: [p.id] },
    });
    expect(res.json().results[0]).toMatchObject({ status: "failed" });
    expect(res.json().results[0].error.code).toBe("VALIDATION_FAILED");
  });

  it("rejects bad input with 400", async () => {
    const ctx = await ctxWithMockCdp();
    const p = ctx.profiles.create({ name: "win-bad", generateFingerprint: true });
    await ctx.app.inject({ method: "POST", url: `/profiles/${p.id}/start`, payload: {} });
    const tiny = await ctx.app.inject({
      method: "POST",
      url: `/profiles/${p.id}/window/bounds`,
      payload: { bounds: { left: 0, top: 0, width: 10, height: 10 } },
    });
    expect(tiny.statusCode).toBe(400);
    const badPreset = await ctx.app.inject({
      method: "POST",
      url: "/profiles/batch-tile",
      payload: { ids: [p.id], preset: "circle" },
    });
    expect(badPreset.statusCode).toBe(400);
  });

  it("closes the CDP connection after tiling — no leaked sockets (audit finding 2)", async () => {
    const ctx = await ctxWithMockCdp();
    const p = ctx.profiles.create({ name: "win-leak", generateFingerprint: true });
    await ctx.app.inject({ method: "POST", url: `/profiles/${p.id}/start`, payload: {} });

    const res = await ctx.app.inject({
      method: "POST",
      url: `/profiles/${p.id}/window/bounds`,
      payload: { bounds: { left: 0, top: 0, width: 1200, height: 800 } },
    });
    expect(res.json()).toMatchObject({ status: "tiled" });
    // The old driverFor() left one CdpConnection open per tiled window.
    // Give the WebSocket close frame a moment, then assert zero remain.
    await new Promise((r) => setTimeout(r, 150));
    expect(server!.openConnectionCount).toBe(0);
  });
});
