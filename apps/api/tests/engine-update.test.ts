import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { EngineInstaller } from "../src/application/engine/engine-installer.js";
import { EngineUpdateService, compareVersions, newestEntry } from "../src/application/engine/engine-update.service.js";
import { makeTestContext } from "./helpers.js";

/**
 * C1 — one-click engine updates: the CLI's checksummed installer offered
 * over HTTP. Check reports current/available; install runs in the
 * background, only with the owner's download consent, one at a time, and a
 * checksum mismatch fails the job without touching the installed engine.
 */

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "qp-engine-update-"));
const PLATFORM = "windows-x64";

function manifestWith(dir: string, versions: Array<{ version: string; bytes: Buffer; badSha?: boolean }>): string {
  const engines = versions.map(({ version, bytes, badSha }) => {
    const file = path.join(dir, `engine-${version}.bin`);
    fs.writeFileSync(file, bytes);
    return {
      kind: "fury-core",
      version,
      platform: PLATFORM,
      url: new URL(`file:///${file.replace(/\\/g, "/")}`).href,
      sha256: badSha ? "0".repeat(64) : createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: bytes.length,
    };
  });
  const ref = path.join(dir, "engines.manifest.json");
  fs.writeFileSync(ref, JSON.stringify({ schemaVersion: 1, engines }));
  return ref;
}

const until = async (cond: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
};

describe("engine manifest selection", () => {
  it("picks the newest entry for the platform; -qp.N orders after its base", () => {
    expect(compareVersions("0.5.5-qp.4", "0.5.5")).toBeGreaterThan(0);
    expect(compareVersions("0.5.10", "0.5.9")).toBeGreaterThan(0);
    const raw = JSON.stringify({
      schemaVersion: 1,
      engines: ["0.5.5-qp.3", "0.5.5-qp.4", "0.5.4"].map((version) => ({ kind: "fury-core", version, platform: PLATFORM, url: "https://x/y", sha256: "a".repeat(64) })),
    });
    expect(newestEntry(raw, "fury-core", PLATFORM)!.version).toBe("0.5.5-qp.4");
    expect(newestEntry(raw, "fury-core", "linux-x64")).toBeNull();
  });
});

describe("EngineUpdateService", () => {
  const make = (consent: boolean, ref: string, enginesDir = tmp()) => {
    let ok = consent;
    const svc = new EngineUpdateService({ enginesDir, manifestRef: ref, consent: () => ok, installer: new EngineInstaller(enginesDir), platform: PLATFORM });
    return { svc, enginesDir, setConsent: (v: boolean) => (ok = v) };
  };

  it("reports available, refuses without consent, installs with it, then reports current", async () => {
    const ref = manifestWith(tmp(), [{ version: "0.5.5-qp.5", bytes: Buffer.from("engine-bytes") }]);
    const { svc, enginesDir, setConsent } = make(false, ref);

    expect(await svc.check()).toMatchObject({ status: "available", consent: false, latest: { version: "0.5.5-qp.5" } });
    await expect(svc.start()).rejects.toMatchObject({ code: "ENGINE_DOWNLOAD_REQUIRES_CONSENT" });
    expect(fs.readdirSync(enginesDir)).toEqual([]); // nothing downloaded

    setConsent(true);
    expect(await svc.start()).toEqual({ started: true, version: "0.5.5-qp.5", status: "started" });
    await until(() => svc["job"]?.state !== "running");
    expect((await svc.check()).job).toMatchObject({ state: "installed", version: "0.5.5-qp.5" });
    expect((await svc.check()).status).toBe("current");
    expect(await svc.start()).toMatchObject({ started: false, status: "current" });
  });

  it("a checksum mismatch fails the job and installs nothing", async () => {
    const ref = manifestWith(tmp(), [{ version: "0.5.5-qp.6", bytes: Buffer.from("tampered"), badSha: true }]);
    const { svc, enginesDir } = make(true, ref);
    await svc.start();
    await until(() => svc["job"]?.state !== "running");
    const { job, status } = await svc.check();
    expect(job).toMatchObject({ state: "failed" });
    expect(job!.error).toMatch(/checksum mismatch/);
    expect(status).toBe("available");
    expect(fs.existsSync(path.join(enginesDir, "fury-core", "0.5.5-qp.6", PLATFORM, "install.json"))).toBe(false);
  });

  it("one install at a time", async () => {
    const ref = manifestWith(tmp(), [{ version: "0.5.5-qp.7", bytes: Buffer.from("x") }]);
    const enginesDir = tmp();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = new EngineInstaller(enginesDir, async (url) => {
      await gate;
      return new Uint8Array(fs.readFileSync(new URL(url)));
    });
    const svc = new EngineUpdateService({ enginesDir, manifestRef: ref, consent: () => true, installer: slow, platform: PLATFORM });
    await svc.start();
    await expect(svc.start()).rejects.toMatchObject({ code: "CONFLICT" });
    release();
    await until(() => svc["job"]?.state !== "running");
  });

  it("an unreadable manifest is reported, not thrown", async () => {
    const { svc } = make(true, path.join(tmp(), "missing.json"));
    expect(await svc.check()).toMatchObject({ status: "error", latest: null });
  });
});

describe("GET/POST /engine/update", () => {
  it("check is open; install honours the consent setting and refuses cross-site requests", async () => {
    const ref = manifestWith(tmp(), [{ version: "0.5.5-qp.8", bytes: Buffer.from("e") }]);
    const ctx = makeTestContext(undefined, { engineManifest: ref });
    const check = await ctx.app.inject({ method: "GET", url: "/engine/update" });
    expect(check.json()).toMatchObject({ status: "available", consent: false });

    const refused = await ctx.app.inject({ method: "POST", url: "/engine/update" });
    expect(refused.statusCode).toBe(403);

    ctx.settings.patch("engine", { downloadConsent: true });
    const crossSite = await ctx.app.inject({ method: "POST", url: "/engine/update", headers: { "sec-fetch-site": "cross-site" } });
    expect(crossSite.statusCode).toBe(403);

    const ok = await ctx.app.inject({ method: "POST", url: "/engine/update" });
    expect(ok.statusCode).toBe(202);
    expect(ok.json()).toMatchObject({ started: true, version: "0.5.5-qp.8" });
  });
});
