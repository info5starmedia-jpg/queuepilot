import { describe, expect, it } from "vitest";
import {
  currentProfileProxy,
  currentProxyIndex,
  maskProxyEntry,
  nextProxyIndex,
  parseProxyEntry,
  profileProxyEntries,
} from "../src/application/profiles/profile-proxies.js";

describe("parseProxyEntry", () => {
  it("parses host:port with no auth, defaulting to http", () => {
    expect(parseProxyEntry("10.0.0.1:8080")).toEqual({
      kind: "direct",
      raw: "10.0.0.1:8080",
      scheme: "http",
      host: "10.0.0.1",
      port: 8080,
      username: null,
      password: null,
    });
  });

  it("parses host:port:user:pass", () => {
    expect(parseProxyEntry("10.0.0.1:8080:alice:s3cret")).toMatchObject({
      kind: "direct",
      host: "10.0.0.1",
      port: 8080,
      username: "alice",
      password: "s3cret",
    });
  });

  it("keeps passwords containing ':' verbatim", () => {
    expect(parseProxyEntry("10.0.0.1:8080:alice:p:a:ss")!.kind).toBe("direct");
    const e = parseProxyEntry("10.0.0.1:8080:alice:p:a:ss");
    if (e?.kind === "direct") expect(e.password).toBe("p:a:ss");
  });

  it("parses explicit schemes", () => {
    const e = parseProxyEntry("socks5://10.0.0.1:1080:bob:pw");
    expect(e).toMatchObject({ kind: "direct", scheme: "socks5", username: "bob", password: "pw" });
  });

  it("honors the system connection magic value case-insensitively", () => {
    expect(parseProxyEntry("system connection")).toEqual({ kind: "system", raw: "system connection" });
    expect(parseProxyEntry("  System Connection ")).toMatchObject({ kind: "system" });
  });

  it("refuses garbage instead of guessing", () => {
    expect(parseProxyEntry("")).toBeNull();
    expect(parseProxyEntry("nohostonly")).toBeNull();
    expect(parseProxyEntry("h:notaport")).toBeNull();
    expect(parseProxyEntry("h:70000")).toBeNull();
    expect(parseProxyEntry("h:0")).toBeNull();
    expect(parseProxyEntry("ftp://h:21")).toBeNull(); // unknown scheme
  });
});

describe("profileProxyEntries / current selection", () => {
  const extra = {
    proxies: ["10.0.0.1:8080", "system connection", "junk", "socks5://10.0.0.2:1080:u:p"],
  };

  it("drops unparseable entries, preserving order", () => {
    const entries = profileProxyEntries(extra);
    expect(entries.map((e) => e.kind)).toEqual(["direct", "system", "direct"]);
  });

  it("selects the current entry by proxyIndex modulo the parseable length", () => {
    expect(currentProfileProxy(extra)?.entry.kind).toBe("direct");
    expect(currentProfileProxy({ ...extra, proxyIndex: 1 })?.entry.kind).toBe("system");
    expect(currentProfileProxy({ ...extra, proxyIndex: 3 })?.entry.kind).toBe("direct"); // wraps
    expect(currentProfileProxy({ ...extra, proxyIndex: -1 })?.entry.kind).toBe("direct");
  });

  it("empty or missing lists → null, never a crash", () => {
    expect(currentProfileProxy(null)).toBeNull();
    expect(currentProfileProxy({})).toBeNull();
    expect(currentProfileProxy({ proxies: [] })).toBeNull();
    expect(currentProfileProxy({ proxies: "junk" })).toBeNull();
  });

  it("currentProxyIndex/nextProxyIndex follow the same discipline as SMS", () => {
    expect(currentProxyIndex(null, 3)).toBe(0);
    expect(currentProxyIndex(null, 0)).toBeNull();
    expect(currentProxyIndex({ proxyIndex: "x" }, 2)).toBe(0);
    expect(nextProxyIndex(null)).toBe(1);
    expect(nextProxyIndex({ proxyIndex: 2 })).toBe(3);
  });
});

describe("maskProxyEntry", () => {
  it("never echoes the password, flags its presence", () => {
    const masked = maskProxyEntry(parseProxyEntry("10.0.0.1:8080:alice:s3cret")!);
    expect(masked).toMatchObject({ kind: "direct", host: "10.0.0.1", username: "alice", hasPassword: true });
    expect(JSON.stringify(masked)).not.toContain("s3cret");
    expect(masked).not.toHaveProperty("password");
  });

  it("hasPassword false without auth and for system entries", () => {
    expect(maskProxyEntry(parseProxyEntry("10.0.0.1:8080")!)).toMatchObject({ hasPassword: false });
    expect(maskProxyEntry(parseProxyEntry("system connection")!)).toEqual({
      kind: "system",
      raw: "system connection",
      hasPassword: false,
    });
  });
});
