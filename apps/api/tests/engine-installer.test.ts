import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { ErrorCodes, type EngineManifestEntryInput } from "@queuepilot/contracts";
import { EngineInstaller } from "../src/application/engine/engine-installer.js";

function makeEntry(payload: Uint8Array, overrides: Partial<EngineManifestEntryInput> = {}): EngineManifestEntryInput {
  return {
    kind: "camoufox",
    version: "1.0.0",
    platform: "linux-x64",
    url: "https://example.invalid/engine.tar.gz",
    sha256: createHash("sha256").update(payload).digest("hex"),
    ...overrides,
  };
}

function makeInstaller() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "queuepilot-engines-"));
  return { dir, installer: new EngineInstaller(dir) };
}

describe("EngineInstaller", () => {
  it("refuses to download without explicit consent — no bytes move", async () => {
    const { installer } = makeInstaller();
    const payload = new TextEncoder().encode("engine-bytes");
    let fetched = false;
    const fetching = new EngineInstaller(
      fs.mkdtempSync(path.join(os.tmpdir(), "queuepilot-engines-")),
      async () => {
        fetched = true;
        return payload;
      },
    );
    void installer;
    await expect(fetching.install(makeEntry(payload), { consent: false })).rejects.toMatchObject({
      code: ErrorCodes.ENGINE_DOWNLOAD_REQUIRES_CONSENT,
    });
    expect(fetched).toBe(false);
  });

  it("installs with consent, verifies sha256, writes a receipt", async () => {
    const payload = new TextEncoder().encode("engine-bytes");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "queuepilot-engines-"));
    const installer = new EngineInstaller(dir, async () => payload);
    const entry = makeEntry(payload);
    const receipt = await installer.install(entry, { consent: true });
    expect(receipt.sha256).toBe(entry.sha256);
    expect(fs.existsSync(path.join(receipt.dir, "payload.bin"))).toBe(true);
    expect(fs.existsSync(path.join(receipt.dir, "install.json"))).toBe(true);
    expect(installer.isInstalled(entry)).toBe(true);
  });

  it("hard-refuses a checksum mismatch and leaves nothing installed", async () => {
    const pinned = new TextEncoder().encode("honest-bytes");
    const tampered = new TextEncoder().encode("tampered-bytes");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "queuepilot-engines-"));
    const installer = new EngineInstaller(dir, async () => tampered);
    const entry = makeEntry(pinned);
    await expect(installer.install(entry, { consent: true })).rejects.toMatchObject({
      code: ErrorCodes.ENGINE_CHECKSUM_MISMATCH,
    });
    expect(installer.isInstalled(entry)).toBe(false);
    expect(fs.existsSync(path.join(dir, "camoufox", "1.0.0", "linux-x64"))).toBe(false);
  });

  it("is idempotent: a verified install is not re-downloaded", async () => {
    const payload = new TextEncoder().encode("engine-bytes");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "queuepilot-engines-"));
    let fetches = 0;
    const installer = new EngineInstaller(dir, async () => {
      fetches++;
      return payload;
    });
    const entry = makeEntry(payload);
    await installer.install(entry, { consent: true });
    const again = await installer.install(entry, { consent: true });
    expect(fetches).toBe(1);
    expect(again.sha256).toBe(entry.sha256);
  });

  it("treats a corrupt receipt as not installed and reinstalls", async () => {
    const payload = new TextEncoder().encode("engine-bytes");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "queuepilot-engines-"));
    let fetches = 0;
    const installer = new EngineInstaller(dir, async () => {
      fetches++;
      return payload;
    });
    const entry = makeEntry(payload);
    const first = await installer.install(entry, { consent: true });
    fs.writeFileSync(path.join(first.dir, "install.json"), "{corrupt");
    expect(installer.isInstalled(entry)).toBe(false);
    await installer.install(entry, { consent: true });
    expect(fetches).toBe(2);
    expect(installer.isInstalled(entry)).toBe(true);
  });
});
