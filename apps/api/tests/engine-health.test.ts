import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { EngineHealthService } from "../src/application/engine/engine-health.service.js";
import {
  CamoufoxRuntime,
  defaultCamoufoxPath,
} from "../src/application/runtime/camoufox.runtime.js";
import { makeTestContext } from "./helpers.js";

describe("engine health", () => {
  it("reports the fake runtime as healthy with no binary requirement", async () => {
    const { app } = makeTestContext();
    const res = await app.inject({ method: "GET", url: "/engine/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      runtime: "fake",
      binaryPath: null,
      binaryPresent: true,
      installs: [],
    });
  });

  it("self-test launches and cleanly stops a throwaway session", async () => {
    const { app, runtime } = makeTestContext();
    const res = await app.inject({ method: "POST", url: "/engine/self-test" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.runtime).toBe("fake");
    expect(body.latencyMs).toBeGreaterThanOrEqual(0);
    // The self-test launched through the runtime but touched no profile.
    expect(runtime.sessions.length).toBe(1);
  });

  it("reports a missing camoufox binary instead of pretending everything is fine", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "queuepilot-health-"));
    const binary = path.join(dir, "engines", "camoufox", "camoufox");
    const health = new EngineHealthService(new CamoufoxRuntime(binary), dir);

    const report = health.health();
    expect(report.runtime).toBe("camoufox");
    expect(report.binaryPath).toBe(binary);
    expect(report.binaryPresent).toBe(false);

    const selfTest = await health.selfTest();
    expect(selfTest.ok).toBe(false);
    expect(selfTest.error).toContain("not found");
  });

  it("lists verified install receipts found under the engines dir", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "queuepilot-health-"));
    const receiptDir = path.join(
      dir,
      "engines",
      "camoufox",
      "1.2.3",
      "windows-x64",
    );
    fs.mkdirSync(receiptDir, { recursive: true });
    const receipt = {
      kind: "camoufox",
      version: "1.2.3",
      platform: "windows-x64",
      sha256: createHash("sha256").update("engine-bytes").digest("hex"),
      url: "https://example.invalid/engine.tar.gz",
      installedAt: new Date().toISOString(),
      dir: receiptDir,
    };
    fs.writeFileSync(
      path.join(receiptDir, "install.json"),
      JSON.stringify(receipt),
    );
    // A corrupt receipt elsewhere must be ignored, not crash the scan.
    const corruptDir = path.join(
      dir,
      "engines",
      "camoufox",
      "9.9.9",
      "linux-x64",
    );
    fs.mkdirSync(corruptDir, { recursive: true });
    fs.writeFileSync(path.join(corruptDir, "install.json"), "{corrupt");

    const health = new EngineHealthService(
      new CamoufoxRuntime(path.join(dir, "nope")),
      dir,
    );
    const report = health.health();
    expect(report.installs).toHaveLength(1);
    expect(report.installs[0]).toMatchObject({
      kind: "camoufox",
      version: "1.2.3",
    });
  });

  it("resolves the camoufox binary from <dataDir>/engines/camoufox/, not the profile dir", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "queuepilot-health-"));
    const enginesDir = path.join(dir, "engines", "camoufox");
    fs.mkdirSync(enginesDir, { recursive: true });
    const binary = path.join(
      enginesDir,
      process.platform === "win32" ? "camoufox.exe" : "camoufox",
    );
    fs.writeFileSync(binary, "not-a-real-browser");

    const runtime = new CamoufoxRuntime(defaultCamoufoxPath(dir));
    expect(runtime.engineBinaryPath()).toBe(binary);
    expect(new EngineHealthService(runtime, dir).health().binaryPresent).toBe(
      true,
    );
  });
});
