import { describe, expect, it } from "vitest";
import { parseProxyLine } from "../src/application/proxies/proxy-import.js";
import { makeTestContext } from "./helpers.js";

/**
 * Proxy list import (B1): POST /proxies/import takes pasted text or a .txt
 * file's contents. Formats, dedupe on host+port, and a partial-failure batch
 * that still imports every good line. Reasons never echo the line.
 */

describe("parseProxyLine formats", () => {
  it("host:port", () => {
    expect(parseProxyLine("10.0.0.1:8080", "http")).toMatchObject({
      name: "10.0.0.1:8080", type: "http", host: "10.0.0.1", port: 8080, username: null, password: null, timezone: null,
    });
  });

  it("host:port:user:pass, password may contain ':'", () => {
    expect(parseProxyLine("p.example.com:2124:alice:se:cr:et", "http")).toMatchObject({
      host: "p.example.com", port: 2124, username: "alice", password: "se:cr:et", timezone: null,
    });
  });

  it("optional 5th field = timezone", () => {
    expect(parseProxyLine("1.2.3.4:80:u:p:America/New_York", "http")).toMatchObject({
      username: "u", password: "p", timezone: "America/New_York",
    });
    // Not a real zone → stays part of the password.
    expect(parseProxyLine("1.2.3.4:80:u:p:Mars/Base", "http")).toMatchObject({ password: "p:Mars/Base", timezone: null });
  });

  it("scheme:// prefix overrides the default type; user:pass@host:port works", () => {
    expect(parseProxyLine("socks5://1.2.3.4:1080:u:p", "http")).toMatchObject({ type: "socks5", username: "u" });
    expect(parseProxyLine("socks5h://1.2.3.4:1080", "http")).toMatchObject({ type: "socks5" });
    expect(parseProxyLine("https://u:p@1.2.3.4:443", "http")).toMatchObject({ type: "https", host: "1.2.3.4", port: 443, username: "u", password: "p" });
  });

  it("name:host:port:user:pass keeps the name (older dashboard paste form)", () => {
    expect(parseProxyLine("ashburn-1:1.2.3.4:2124:u:p", "http")).toMatchObject({ name: "ashburn-1", host: "1.2.3.4", port: 2124 });
  });

  it("blank lines and # comments are ignored", () => {
    expect(parseProxyLine("   ", "http")).toBeNull();
    expect(parseProxyLine("# my proxies", "http")).toBeNull();
  });

  it("bad lines throw a reason that never contains the line", () => {
    for (const bad of ["1.2.3.4", "1.2.3.4:notaport:u:secretpw", "ftp://1.2.3.4:21", "1.2.3.4:70000", "bad host!:80"]) {
      let reason = "";
      try {
        parseProxyLine(bad, "http");
      } catch (err) {
        reason = (err as Error).message;
      }
      expect(reason, bad).not.toBe("");
      expect(reason).not.toContain("secretpw");
    }
  });
});

describe("POST /proxies/import", () => {
  it("imports a pasted list, stores passwords + timezone, reports a summary", async () => {
    const ctx = makeTestContext();
    const text = ["# provider export", "", "1.1.1.1:80:u1:p1", "2.2.2.2:81:u2:p2:Europe/Berlin", "socks5://3.3.3.3:1080"].join("\n");
    const res = await ctx.app.inject({ method: "POST", url: "/proxies/import", payload: { text } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ added: 3, skipped: 0, errors: [] });
    const list = ctx.proxies.list();
    expect(list).toHaveLength(3);
    const berlin = list.find((p) => p.host === "2.2.2.2")!;
    expect(berlin.timezone).toBe("Europe/Berlin");
    expect(ctx.proxies.getStored(berlin.id).password).toBe("p2");
    expect(JSON.stringify(res.json())).not.toContain("p2");
  });

  it("dedupes on host+port against stored proxies and within the batch", async () => {
    const ctx = makeTestContext();
    await ctx.proxies.create({ name: "existing", type: "http", host: "Proxy.Example.com", port: 8080 });
    const text = "proxy.example.com:8080:u:p\n9.9.9.9:1:u:p\n9.9.9.9:1:other:pw\n9.9.9.9:2";
    const res = await ctx.app.inject({ method: "POST", url: "/proxies/import", payload: { text } });
    expect(res.json()).toEqual({ added: 2, skipped: 2, errors: [] });
    expect(ctx.proxies.list()).toHaveLength(3);
  });

  it("a bad line never fails the batch; errors carry the 1-based line number", async () => {
    const ctx = makeTestContext();
    const text = "1.1.1.1:80\nnot-a-proxy\n2.2.2.2:99999:u:topsecret\n3.3.3.3:81";
    const res = await ctx.app.inject({ method: "POST", url: "/proxies/import", payload: { text } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.added).toBe(2);
    expect(body.errors.map((e: { line: number }) => e.line)).toEqual([2, 3]);
    expect(JSON.stringify(body)).not.toContain("topsecret");
  });

  it("accepts a .txt file's raw bytes as text/plain, with ?type= as the default scheme", async () => {
    const ctx = makeTestContext();
    const res = await ctx.app.inject({
      method: "POST",
      url: "/proxies/import?type=socks5",
      headers: { "content-type": "text/plain" },
      payload: "4.4.4.4:1080:u:p\r\n5.5.5.5:1081\r\n",
    });
    expect(res.json()).toEqual({ added: 2, skipped: 0, errors: [] });
    expect(ctx.proxies.list().every((p) => p.type === "socks5")).toBe(true);
  });

  it("rejects a body without text", async () => {
    const ctx = makeTestContext();
    const res = await ctx.app.inject({ method: "POST", url: "/proxies/import", payload: { type: "http" } });
    expect(res.statusCode).toBe(400);
  });
});
