import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { ErrorCodes, type EngineManifestEntryInput } from "@queuepilot/contracts";
import { makeTestContext } from "./helpers.js";
import { loadConfig } from "../src/config/config.js";
import { EngineInstaller } from "../src/application/engine/engine-installer.js";
import { ResolverRegistry, registerBuiltinResolvers } from "../src/application/resolvers/resolver-registry.js";
import { registerImapResolver } from "../src/application/resolvers/imap-resolver.js";

/**
 * P0 security fixes, audit 2026-11-20 (docs/audit-2026-11-20.md §6).
 *
 * Each describe block pins one fix so a regression re-opens the hole loudly:
 * SEC-1 reflected XSS in the OAuth callback + global security headers,
 * SEC-2 deny-by-default origin wall + JSON content-type on mutating routes,
 * item 3 default-on auto-generated API token, SEC-5 IMAP CRLF injection,
 * SEC-3 manifest binaryPath traversal.
 */

describe("P0 SEC-1: OAuth callback escaping + security headers", () => {
  it("escapes a reflected error parameter (stored/reflected XSS)", async () => {
    const ctx = makeTestContext();
    const res = await ctx.app.inject({
      method: "GET",
      url: "/google/auth/callback?error=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E",
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("&lt;img");
    expect(res.body).not.toContain("<img");
    expect(res.body).not.toContain("onerror=alert(1)>");
  });

  it("sends CSP, nosniff and frame-deny headers on API responses", async () => {
    const ctx = makeTestContext();
    const res = await ctx.app.inject({ method: "GET", url: "/health" });
    expect(res.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(res.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("DENY");
  });
});

describe("P0 SEC-2: deny-by-default origin wall", () => {
  it("refuses a cross-origin GET on a previously unguarded route", async () => {
    const ctx = makeTestContext();
    const res = await ctx.app.inject({
      method: "GET",
      url: "/profiles",
      headers: { origin: "http://evil.com" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("refuses DNS-rebinding Host headers", async () => {
    const ctx = makeTestContext();
    const res = await ctx.app.inject({
      method: "GET",
      url: "/profiles",
      headers: { host: "evil.com" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
  });

  it("refuses cross-site fetches (Sec-Fetch-Site) on any route", async () => {
    const ctx = makeTestContext();
    const res = await ctx.app.inject({
      method: "GET",
      url: "/proxies",
      headers: { "sec-fetch-site": "cross-site" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("still allows plain local clients (no browser fingerprints)", async () => {
    const ctx = makeTestContext();
    const res = await ctx.app.inject({ method: "GET", url: "/profiles" });
    expect(res.statusCode).toBe(200);
  });

  it("still allows loopback origins (dashboard on localhost)", async () => {
    const ctx = makeTestContext();
    const res = await ctx.app.inject({
      method: "GET",
      url: "/profiles",
      headers: { origin: "http://localhost:50325", host: "127.0.0.1:50325" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("415s a browser-originated body-bearing mutating request that is not JSON/multipart", async () => {
    const ctx = makeTestContext();
    // A same-origin page's "simple request" form POST: Origin present,
    // text/plain body — the wall must refuse the write.
    const res = await ctx.app.inject({
      method: "POST",
      url: "/profiles",
      headers: { "content-type": "text/plain", origin: "http://127.0.0.1:50325" },
      payload: 'name=evil", "isAdmin": true',
    });
    expect(res.statusCode).toBe(415);
    expect(res.json().error.code).toBe("UNSUPPORTED_MEDIA_TYPE");
  });

  // Note: no "empty content-type" test exists on purpose — fastify's body
  // parser 415s a body-bearing request without a content-type before any
  // hook runs, so the wall's empty-ct exemption is unreachable at HTTP level.
});

describe("P0 item 3: default-on API token", () => {
  it("auto-generates and persists a token when the env has none", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qp-p0-config-"));
    const cfg = loadConfig({ SPECTRA_DATA_DIR: dir } as NodeJS.ProcessEnv);
    expect(cfg.apiToken).toBeTruthy();
    expect(cfg.apiToken!.length).toBeGreaterThanOrEqual(20);
    expect(cfg.apiTokenAuto).toBe(true);
    const file = path.join(dir, "api-token");
    expect(fs.readFileSync(file, "utf8")).toBe(cfg.apiToken);
    // A second load must return the SAME token, not rotate it.
    const again = loadConfig({ SPECTRA_DATA_DIR: dir } as NodeJS.ProcessEnv);
    expect(again.apiToken).toBe(cfg.apiToken);
  });

  it("uses the env token as-is and never writes the file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qp-p0-config-"));
    const cfg = loadConfig({
      SPECTRA_DATA_DIR: dir,
      SPECTRA_API_TOKEN: "operator-set-token",
    } as NodeJS.ProcessEnv);
    expect(cfg.apiToken).toBe("operator-set-token");
    expect(cfg.apiTokenAuto).toBe(false);
    expect(fs.existsSync(path.join(dir, "api-token"))).toBe(false);
  });

  it("token-protects the API and serves the token to the same-origin dashboard only", async () => {
    const ctx = makeTestContext(undefined, { apiToken: "test-token-123" });
    // No Authorization → 401 on data routes.
    expect((await ctx.app.inject({ method: "GET", url: "/profiles" })).statusCode).toBe(401);
    // With Authorization → 200.
    const ok = await ctx.app.inject({
      method: "GET",
      url: "/profiles",
      headers: { authorization: "Bearer test-token-123" },
    });
    expect(ok.statusCode).toBe(200);
    // The token endpoint itself needs no auth (the page must read it to sign in)…
    const tok = await ctx.app.inject({ method: "GET", url: "/dashboard/session-token" });
    expect(tok.statusCode).toBe(200);
    expect(tok.json().token).toBe("test-token-123");
    // …but the origin wall still applies to it: a DNS-rebinding page can't read it.
    const evil = await ctx.app.inject({
      method: "GET",
      url: "/dashboard/session-token",
      headers: { host: "evil.com" },
    });
    expect(evil.statusCode).toBe(403);
  });
});

describe("P0 SEC-5: IMAP CRLF injection", () => {
  function makeReg() {
    const reg = new ResolverRegistry();
    registerBuiltinResolvers(reg);
    registerImapResolver(reg);
    return reg;
  }

  it("refuses a query containing CRLF instead of sending it to the server", async () => {
    const reg = makeReg();
    // %0d%0a decodes to CRLF inside the SEARCH command — without the fix this
    // appends "A STORE 1:* +FLAGS \Deleted" to the IMAP conversation.
    const v = await reg.resolve(
      "imap://127.0.0.1:993?tls=false&user=u&pass=p&query=UNSEEN%0d%0aA%20STORE%201:*%20%2BFLAGS%20%5CDeleted",
      {},
    );
    expect(v).toMatch(/^#BAD SPEC/);
    expect(v).toContain("control characters");
    expect(v).not.toContain("STORE");
  });

  it("refuses credentials containing control characters", async () => {
    const reg = makeReg();
    const v = await reg.resolve(
      "imap://127.0.0.1:993?tls=false&user=u%0d%0aLOGIN%20admin%20x&pass=p",
      {},
    );
    expect(v).toMatch(/^#BAD SPEC/);
  });
});

describe("P0 SEC-3: engine manifest binaryPath lockdown", () => {
  function makeEntry(payload: Uint8Array, overrides: Partial<EngineManifestEntryInput> = {}): EngineManifestEntryInput {
    return {
      kind: "fury-core",
      version: "1.0.0",
      platform: "win32-x64",
      url: "https://example.invalid/engine.tar.gz",
      sha256: createHash("sha256").update(payload).digest("hex"),
      ...overrides,
    };
  }

  function makeInstaller(payload: Uint8Array) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "queuepilot-engines-"));
    return { dir, installer: new EngineInstaller(dir, async () => payload) };
  }

  const payload = new TextEncoder().encode("engine-bytes");

  it.each([
    ["parent traversal", "../evil.exe"],
    ["nested traversal", "bin/../../evil.exe"],
    ["absolute windows path", "C:\\Windows\\System32\\evil.exe"],
  ])("refuses %s (%s)", async (_label, binaryPath) => {
    const { installer } = makeInstaller(payload);
    await expect(
      installer.install(makeEntry(payload, { binaryPath }), { consent: true }),
    ).rejects.toMatchObject({ code: ErrorCodes.ENGINE_MANIFEST_INVALID });
    expect(installer.isInstalled(makeEntry(payload, { binaryPath }))).toBe(false);
  });

  it("accepts a plain relative binaryPath", async () => {
    const { installer } = makeInstaller(payload);
    // archive "raw" keeps payload.bin in staging; binaryPath must exist
    // there — payload.bin is the real extracted file for raw archives.
    const receipt = await installer.install(
      makeEntry(payload, { binaryPath: "payload.bin" }),
      { consent: true },
    );
    expect(receipt.sha256).toBe(makeEntry(payload).sha256);
  });
});
