import { describe, expect, it } from "vitest";
import { makeTestContext } from "./helpers.js";

/**
 * Proxy health history (v0.16.0): every test() appends to proxy_health,
 * retention-bounded at 200 rows per proxy. Operators can see a proxy's
 * reliability over time instead of a single point-in-time probe.
 */

describe("proxy health history", () => {
  it("records every test() outcome, newest first", async () => {
    const ctx = makeTestContext();
    const p = ctx.proxies.create({ name: "flaky", type: "http", host: "127.0.0.1", port: 1 });

    await ctx.proxies.test(p.id, 300); // dead port -> ok:false
    await ctx.proxies.test(p.id, 300);

    const res = await ctx.app.inject({ method: "GET", url: `/proxies/${p.id}/health` });
    expect(res.statusCode).toBe(200);
    const { history } = res.json();
    expect(history).toHaveLength(2);
    expect(history[0].ok).toBe(false);
    expect(history[0].error).toBeTruthy();
    expect(history[0].checkedAt >= history[1].checkedAt).toBe(true);
    expect(history[0]).not.toHaveProperty("password");
  });

  it("captures exit IP + geo on success (fake proxy)", async () => {
    const net = await import("node:net");
    const body = JSON.stringify({
      status: "success",
      query: "198.51.100.9",
      country: "Canada",
      regionName: "Ontario",
      city: "Toronto",
      timezone: "America/Toronto",
    });
    const server = net.createServer((socket) => {
      socket.once("data", () => {
        socket.end(
          `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
        );
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as import("node:net").AddressInfo).port;

    try {
      const ctx = makeTestContext();
      const p = ctx.proxies.create({ name: "ok", type: "http", host: "127.0.0.1", port });
      await ctx.proxies.test(p.id, 2000, "http://probe.example/json");

      const res = await ctx.app.inject({ method: "GET", url: `/proxies/${p.id}/health` });
      const entry = res.json().history[0];
      expect(entry.ok).toBe(true);
      expect(entry.exitIp).toBe("198.51.100.9");
      expect(entry.geo.country).toBe("Canada");
      expect(entry.latencyMs).not.toBeNull();
    } finally {
      server.close();
    }
  });

  it("limit narrows the window; unknown proxy 404s", async () => {
    const ctx = makeTestContext();
    const p = ctx.proxies.create({ name: "limited", type: "http", host: "127.0.0.1", port: 1 });
    for (let i = 0; i < 3; i++) await ctx.proxies.test(p.id, 300);

    const res = await ctx.app.inject({ method: "GET", url: `/proxies/${p.id}/health?limit=2` });
    expect(res.json().history).toHaveLength(2);

    const missing = await ctx.app.inject({ method: "GET", url: "/proxies/nope/health" });
    expect(missing.statusCode).toBe(404);
  });

  it("deleting a proxy cascades its history", async () => {
    const ctx = makeTestContext();
    const p = ctx.proxies.create({ name: "gone", type: "http", host: "127.0.0.1", port: 1 });
    await ctx.proxies.test(p.id, 300);
    await ctx.app.inject({ method: "DELETE", url: `/proxies/${p.id}` });
    const res = await ctx.app.inject({ method: "GET", url: `/proxies/${p.id}/health` });
    expect(res.statusCode).toBe(404);
  });
});
