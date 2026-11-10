import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { EngineInstaller } from "../src/application/engine/engine-installer.js";
import {
  currentPlatformTag,
  runEngineInstall,
} from "../src/cli/engine-install.js";

/**
 * CLI: `queuepilot engine install`. The consent gate and checksum discipline
 * are the same EngineInstaller rules, exercised through the command surface:
 * exit 0 installed/already-installed, 1 refused/failed, 2 usage/manifest
 * errors, 3 checksum mismatch (a distinct code because it is a security event).
 */
describe("engine install CLI", () => {
  function makeFixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "queuepilot-cli-"));
    const enginesDir = path.join(dir, "engines");
    const payload = new TextEncoder().encode("fake-engine-bytes");
    const payloadPath = path.join(dir, "engine.bin");
    fs.writeFileSync(payloadPath, payload);
    const entry = {
      kind: "camoufox",
      version: "1.2.3",
      platform: currentPlatformTag(),
      url: pathToFileURL(payloadPath).href,
      sha256: createHash("sha256").update(payload).digest("hex"),
    };
    const manifestPath = path.join(dir, "manifest.json");
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({ schemaVersion: 1, engines: [entry] }),
    );
    return { dir, enginesDir, payload, entry, manifestPath };
  }

  const silent = () => {};

  it("refuses without --yes and moves no bytes", async () => {
    const { enginesDir, payload, manifestPath } = makeFixture();
    let fetches = 0;
    const installer = new EngineInstaller(enginesDir, async () => {
      fetches++;
      return payload;
    });
    const code = await runEngineInstall(["--manifest", manifestPath], {
      enginesDir,
      installer,
      log: silent,
    });
    expect(code).toBe(1);
    expect(fetches).toBe(0);
  });

  it("installs with --yes, verifies the checksum, and is idempotent on rerun", async () => {
    const { enginesDir, payload, entry, manifestPath } = makeFixture();
    const installer = new EngineInstaller(enginesDir, async () => payload);

    const code = await runEngineInstall(["--manifest", manifestPath, "--yes"], {
      enginesDir,
      installer,
      log: silent,
    });
    expect(code).toBe(0);
    expect(installer.isInstalled(entry)).toBe(true);

    const again = await runEngineInstall(
      ["--manifest", manifestPath, "--yes"],
      {
        enginesDir,
        installer,
        log: silent,
      },
    );
    expect(again).toBe(0);
  });

  it("exits 3 on checksum mismatch and installs nothing", async () => {
    const { enginesDir, entry, manifestPath, dir } = makeFixture();
    const tamperedEntry = {
      ...entry,
      sha256: createHash("sha256").update("other").digest("hex"),
    };
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({ schemaVersion: 1, engines: [tamperedEntry] }),
    );

    const code = await runEngineInstall(["--manifest", manifestPath, "--yes"], {
      enginesDir,
      log: silent,
    });
    expect(code).toBe(3);
    expect(fs.existsSync(path.join(dir, "engines", "camoufox"))).toBe(false);
  });

  it("rejects a missing or invalid manifest with exit 2", async () => {
    const { dir, enginesDir } = makeFixture();
    expect(
      await runEngineInstall(["--manifest", path.join(dir, "nope.json")], {
        enginesDir,
        log: silent,
      }),
    ).toBe(2);

    const bad = path.join(dir, "bad.json");
    fs.writeFileSync(bad, JSON.stringify({ schemaVersion: 2, engines: [] }));
    expect(
      await runEngineInstall(["--manifest", bad], { enginesDir, log: silent }),
    ).toBe(2);
  });

  it("exits 2 when no manifest entry matches the requested platform", async () => {
    const { enginesDir, manifestPath } = makeFixture();
    const code = await runEngineInstall(
      ["--manifest", manifestPath, "--platform", "plan9-mips", "--yes"],
      { enginesDir, log: silent },
    );
    expect(code).toBe(2);
  });

  it("prints usage with exit 2 when --manifest is missing", async () => {
    const { enginesDir } = makeFixture();
    expect(await runEngineInstall([], { enginesDir, log: silent })).toBe(2);
  });
});
