import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { APP_VERSION } from "../src/version.js";
import { AppUpdateService } from "../src/application/update/app-update.service.js";

/** Version guard: version.ts must equal apps/api/package.json. */
describe("app version", () => {
  it("matches apps/api/package.json", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")) as { version: string };
    expect(APP_VERSION).toBe(pkg.version);
  });
});

function jsonResponse(body: unknown, ok = true): Response {
  return new Response(JSON.stringify(body), { status: ok ? 200 : 500 });
}

const LATEST = {
  version: "99.0.0",
  url: "https://example.test/queuepilot.zip",
  sha256: crypto.createHash("sha256").update("zip-bytes").digest("hex"),
  sizeBytes: 9,
};

const LATEST_URL = "https://example.test/latest.json";

function fetchFor(map: Record<string, unknown>): typeof fetch {
  return (async (url: string | URL) => {
    const key = String(url);
    if (key in map) return jsonResponse(map[key]);
    if (key.endsWith(".zip")) return new Response("zip-bytes", { status: 200 });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

function releaseDir(): { dir: string; zip: Buffer } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qp-release-"));
  fs.writeFileSync(path.join(dir, "install.json"), JSON.stringify({ flavor: "release", version: APP_VERSION }));
  fs.writeFileSync(path.join(dir, "update-app.ps1"), "# stub\n");
  return { dir, zip: Buffer.from("zip-bytes") };
}

describe("AppUpdateService", () => {
  it("reports a dev checkout as unavailable (git is the updater)", async () => {
    const svc = new AppUpdateService({ consent: () => true, dataDir: os.tmpdir(), appRoot: null, platform: "win32", fetchImpl: fetchFor({}) });
    const check = await svc.check();
    expect(check.flavor).toBe("dev");
    expect(check.status).toBe("unavailable");
    expect(check.error).toMatch(/git pull/);
    expect(check.version).toBe(APP_VERSION);
  });

  it("reports current when the release is not newer", async () => {
    const { dir } = releaseDir();
    const current = { ...LATEST, version: APP_VERSION };
    const svc = new AppUpdateService({ consent: () => true, dataDir: dir, appRoot: dir, platform: "win32", latestRef: LATEST_URL, fetchImpl: fetchFor({ "https://example.test/latest.json": current }) });
    const check = await svc.check();
    expect(check.status).toBe("current");
    expect(check.flavor).toBe("release");
    expect(check.latest?.version).toBe(APP_VERSION);
  });

  it("reports available when the release is newer", async () => {
    const { dir } = releaseDir();
    const svc = new AppUpdateService({ consent: () => true, dataDir: dir, appRoot: dir, platform: "win32", latestRef: LATEST_URL, fetchImpl: fetchFor({ "https://example.test/latest.json": LATEST }) });
    expect((await svc.check()).status).toBe("available");
  });

  it("surfaces fetch errors instead of throwing from check", async () => {
    const { dir } = releaseDir();
    const svc = new AppUpdateService({
      consent: () => true,
      dataDir: dir,
      appRoot: dir, platform: "win32",
      latestRef: LATEST_URL,
      fetchImpl: (async () => new Response("boom", { status: 500 })) as typeof fetch,
    });
    const check = await svc.check();
    expect(check.status).toBe("error");
    expect(check.error).toMatch(/HTTP 500/);
  });

  it("refuses to install without consent", async () => {
    const { dir } = releaseDir();
    const svc = new AppUpdateService({ consent: () => false, dataDir: dir, appRoot: dir, platform: "win32", latestRef: LATEST_URL, fetchImpl: fetchFor({ "https://example.test/latest.json": LATEST }) });
    await expect(svc.start()).rejects.toThrow(/downloads are off/);
  });

  it("refuses to install on a dev checkout even with consent", async () => {
    const svc = new AppUpdateService({ consent: () => true, dataDir: os.tmpdir(), appRoot: null, platform: "win32", fetchImpl: fetchFor({}) });
    await expect(svc.start()).rejects.toThrow(/git pull/);
  });

  it("happy path: downloads, verifies, writes the zip, spawns the swap helper, exits", async () => {
    const { dir } = releaseDir();
    const spawned: { cmd: string; args: string[] }[] = [];
    let exited = 0;
    const svc = new AppUpdateService({
      consent: () => true,
      dataDir: dir,
      appRoot: dir, platform: "win32",
      latestRef: LATEST_URL,
      fetchImpl: fetchFor({ "https://example.test/latest.json": LATEST }),
      spawnImpl: (cmd: string, args: string[]) => void spawned.push({ cmd, args }),
      exitImpl: () => void exited++,
    });
    const r = await svc.start();
    expect(r).toEqual({ started: true, version: "99.0.0", status: "started" });
    // the install runs in the background — wait for it
    for (let i = 0; i < 50; i++) {
      const job = (await svc.check()).job;
      if (job?.state === "restarting" || job?.state === "failed") break;
      await new Promise((res) => setTimeout(res, 20));
    }
    expect(exited).toBe(1);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.cmd).toBe("powershell.exe");
    const args = spawned[0]!.args;
    expect(args).toContain("-File");
    expect(args).toContain(path.join(dir, "update-app.ps1"));
    expect(args[args.indexOf("-AppRoot") + 1]).toBe(dir);
    const zipArg = args[args.indexOf("-Zip") + 1]!;
    expect(fs.existsSync(zipArg)).toBe(true);
    expect(fs.readFileSync(zipArg).toString()).toBe("zip-bytes");
    expect((await svc.check()).job?.state).toBe("restarting");
  });

  it("a bad hash fails the job without spawning anything", async () => {
    const { dir } = releaseDir();
    const spawned: unknown[] = [];
    const bad = { ...LATEST, sha256: "0".repeat(64) };
    const svc = new AppUpdateService({
      consent: () => true,
      dataDir: dir,
      appRoot: dir, platform: "win32",
      latestRef: LATEST_URL,
      fetchImpl: fetchFor({ "https://example.test/latest.json": bad }),
      spawnImpl: () => void spawned.push(1),
      exitImpl: () => {},
    });
    await svc.start();
    for (let i = 0; i < 50; i++) {
      const job = (await svc.check()).job;
      if (job?.state === "failed") break;
      await new Promise((res) => setTimeout(res, 20));
    }
    expect(spawned).toHaveLength(0);
    const job = (await svc.check()).job;
    expect(job?.state).toBe("failed");
    expect(job?.error).toMatch(/sha256 mismatch/);
  });

  it("an up-to-date release reports current without downloading", async () => {
    const { dir } = releaseDir();
    const current = { ...LATEST, version: APP_VERSION };
    const svc = new AppUpdateService({ consent: () => true, dataDir: dir, appRoot: dir, platform: "win32", latestRef: LATEST_URL, fetchImpl: fetchFor({ "https://example.test/latest.json": current }) });
    expect(await svc.start()).toEqual({ started: false, version: APP_VERSION, status: "current" });
  });
});
