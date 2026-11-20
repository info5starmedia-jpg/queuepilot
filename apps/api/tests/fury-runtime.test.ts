import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ErrorCodes, type FingerprintIdentity, type Profile } from "@queuepilot/contracts";
import {
  ENGINE_FEATURE_SWITCHES,
  FuryCoreRuntime,
  personaConfig,
  resolveFuryBinary,
  waitForCdpReady,
} from "../src/application/runtime/fury-core.runtime.js";
import http from "node:http";

/**
 * Fury core runtime — the persona mapping is the load-bearing piece (it is
 * the contract between our identity model and the engine's C++ config), so
 * it is tested pure. Binary resolution is tested against a synthetic
 * engines/ tree. The live launch path is exercised manually on a real
 * fury-core install (see ADR-0006 spike) — a browser process is out of scope
 * for unit tests.
 */
const identity: FingerprintIdentity = {
  id: "11111111-1111-4111-8111-111111111111",
  seed: 123456,
  platform: "windows",
  screenWidth: 2560,
  screenHeight: 1440,
  hardwareConcurrency: 12,
  deviceMemoryGb: 16,
  timezone: "America/Toronto",
  locale: "en-US",
  createdAt: new Date().toISOString(),
};

describe("engine feature switches", () => {
  it("turns off the Secure DNS auto-upgrade, in a single --disable-features", () => {
    const disables = ENGINE_FEATURE_SWITCHES.filter((s) => s.startsWith("--disable-features="));
    expect(disables).toHaveLength(1); // Chromium keeps only the last one
    expect(disables[0]!.split("=")[1]!.split(",")).toContain("DnsOverHttpsUpgrade");
  });

  it("hides the crash-restore bubble (QA issue 10 backup to the exit_type hygiene)", () => {
    expect(ENGINE_FEATURE_SWITCHES).toContain("--hide-crash-restore-bubble");
  });
});

describe("personaConfig", () => {
  it("maps every identity field to the fury schema v1 keys", () => {
    const cfg = personaConfig(identity) as Record<string, Record<string, unknown>>;
    expect(cfg.schema_version).toBe(1);
    expect(cfg.navigator).toMatchObject({
      hardwareConcurrency: 12,
      deviceMemory: 16,
      platform: "Win32",
    });
    expect(cfg.screen).toMatchObject({
      width: 2560,
      height: 1440,
      colorDepth: 24,
      devicePixelRatio: 1,
    });
    expect(cfg.locale).toEqual({
      timezone: "America/Toronto",
      locale: "en-US",
    });
    expect(cfg.automation).toEqual({ hideTraces: true });
  });

  it("derives stable, distinct noise seeds from the identity seed", () => {
    const a = personaConfig(identity) as { noise: Record<string, number> };
    const b = personaConfig(identity) as { noise: Record<string, number> };
    expect(a.noise).toEqual(b.noise); // deterministic
    const seeds = Object.values(a.noise);
    expect(new Set(seeds).size).toBe(seeds.length); // distinct per surface
  });

  it("maps platforms to Chromium navigator.platform values", () => {
    const p = (platform: FingerprintIdentity["platform"]) =>
      (
        personaConfig({ ...identity, platform }) as {
          navigator: { platform: string };
        }
      ).navigator.platform;
    expect(p("windows")).toBe("Win32");
    expect(p("macos")).toBe("MacIntel");
    expect(p("linux")).toBe("Linux x86_64");
  });

  it("declares only the schema version when there is no identity", () => {
    expect(personaConfig(null)).toEqual({ schema_version: 1 });
  });
});

describe("launch proxy handling (P0 — never silently direct)", () => {
  const profile: Profile = {
    id: "00000000-0000-4000-8000-000000000000",
    name: "p",
    group: "test",
    proxyId: null,
    identityId: null,
    status: "idle",
    notes: "",
    tags: [],
    email: null,
    providerId: null,
    providerKey: null,
    extra: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  it("refuses to launch with a proxy scheme the relay cannot honor", async () => {
    // process.execPath exists, so the binary check passes and the proxy
    // validation is what must throw — BEFORE any process is spawned.
    // (socks5 is honored since P7.2; ftp never is.)
    const runtime = new FuryCoreRuntime(process.execPath);
    await expect(
      runtime.launch({
        profile,
        identity: null,
        proxyUrl: "ftp://127.0.0.1:21",
        profileDataDir: fs.mkdtempSync(path.join(os.tmpdir(), "queuepilot-fury-launch-")),
      }),
    ).rejects.toMatchObject({ code: ErrorCodes.PROXY_UNSUPPORTED });
  });

  it("refuses to launch with an unparseable proxy URL", async () => {
    const runtime = new FuryCoreRuntime(process.execPath);
    await expect(
      runtime.launch({
        profile,
        identity: null,
        proxyUrl: "::::",
        profileDataDir: fs.mkdtempSync(path.join(os.tmpdir(), "queuepilot-fury-launch-")),
      }),
    ).rejects.toMatchObject({ code: ErrorCodes.PROXY_UNSUPPORTED });
  });
});

describe("resolveFuryBinary", () => {
  it("returns null when nothing is installed", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "queuepilot-fury-"));
    expect(resolveFuryBinary(dir)).toBeNull();
  });

  it("finds the newest verified receipt with a present binary", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "queuepilot-fury-"));
    const installDir = path.join(dir, "engines", "fury-core", "0.5.1", "windows-x64");
    fs.mkdirSync(path.join(installDir, "Fury"), { recursive: true });
    fs.writeFileSync(path.join(installDir, "Fury", "chrome.exe"), "fake");
    fs.writeFileSync(
      path.join(installDir, "install.json"),
      JSON.stringify({
        kind: "fury-core",
        version: "0.5.1",
        platform: "windows-x64",
        sha256: "a".repeat(64),
        url: "https://example.com/fury.tar.xz",
        installedAt: new Date().toISOString(),
        dir: installDir,
        binaryPath: "Fury/chrome.exe",
      }),
    );
    expect(resolveFuryBinary(dir)).toBe(path.join(installDir, "Fury", "chrome.exe"));
  });

  it("ignores receipts whose binary is missing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "queuepilot-fury-"));
    const installDir = path.join(dir, "engines", "fury-core", "0.5.1", "windows-x64");
    fs.mkdirSync(installDir, { recursive: true });
    fs.writeFileSync(
      path.join(installDir, "install.json"),
      JSON.stringify({
        kind: "fury-core",
        version: "0.5.1",
        platform: "windows-x64",
        sha256: "a".repeat(64),
        url: "https://example.com/fury.tar.xz",
        installedAt: new Date().toISOString(),
        dir: installDir,
        binaryPath: "Fury/chrome.exe",
      }),
    );
    expect(resolveFuryBinary(dir)).toBeNull();
  });
});

describe("waitForCdpReady", () => {
  function mockServer(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<{ port: number; close: () => Promise<void> }> {
    return new Promise((resolve) => {
      const server = http.createServer(handler);
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        resolve({ port, close: () => new Promise((r) => server.close(() => r())) });
      });
    });
  }

  it("resolves as soon as /json/version answers", async () => {
    let hits = 0;
    const srv = await mockServer((req, res) => {
      if (req.url === "/json/version") {
        hits++;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ Browser: "fury/1.0" }));
        return;
      }
      res.writeHead(404).end();
    });
    try {
      await waitForCdpReady(srv.port, 5_000);
      expect(hits).toBeGreaterThan(0);
    } finally {
      await srv.close();
    }
  });

  it("retries through connection refusals, then times out with a named error", async () => {
    // Nothing listens on this port: every poll is a refusal.
    const probe = http.createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const addr = probe.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    await new Promise<void>((r) => probe.close(() => r()));
    const started = Date.now();
    await expect(waitForCdpReady(port, 1_000)).rejects.toThrow(/did not answer within/);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });
});
