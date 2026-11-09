import { describe, expect, it } from "vitest";
import { DomainError, ErrorCodes } from "@queuepilot/contracts";
import { makeTestContext } from "./helpers.js";

describe("ProxyService", () => {
  it("never exposes passwords through the public contract", () => {
    const { proxies } = makeTestContext();
    const p = proxies.create({
      name: "dc-1",
      type: "socks5",
      host: "127.0.0.1",
      port: 1080,
      username: "u",
      password: "supersecret",
    });
    expect("password" in p).toBe(false);
    const listed = proxies.list();
    expect(listed).toHaveLength(1);
    expect("password" in listed[0]!).toBe(false);
  });

  it("refuses to delete a proxy still used by a profile", () => {
    const { proxies, profiles } = makeTestContext();
    const proxy = proxies.create({ name: "in-use", type: "http", host: "10.0.0.1", port: 8080 });
    profiles.create({ name: "attached", proxyId: proxy.id, generateFingerprint: false });
    try {
      proxies.delete(proxy.id);
      expect.unreachable();
    } catch (err) {
      expect((err as DomainError).code).toBe(ErrorCodes.CONFLICT);
    }
  });

  it("reports test() failure for an unreachable proxy without throwing", async () => {
    const { proxies } = makeTestContext();
    // Port 1 is closed on any sane machine.
    const p = proxies.create({ name: "dead", type: "http", host: "127.0.0.1", port: 1 });
    const result = await proxies.test(p.id, 500);
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});
