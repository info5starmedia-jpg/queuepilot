import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  InstalledEngineSchema,
  type EngineHealth,
  type EngineSelfTestResult,
  type InstalledEngine,
  type Profile,
} from "@queuepilot/contracts";
import type { BrowserRuntime } from "../runtime/browser-runtime.js";

/**
 * EngineHealthService — the pre-flight check for the engine layer.
 *
 * health() answers "which runtime is serving launches and is its binary
 * actually there" without launching anything. selfTest() answers "can the
 * runtime really spawn and cleanly reap a browser" by launching a throwaway
 * session with a synthetic profile and stopping it immediately — it touches
 * no profile, no run row, no snapshot; the DB never sees it.
 */
export class EngineHealthService {
  constructor(
    private readonly runtime: BrowserRuntime,
    private readonly dataDir: string,
  ) {}

  health(): EngineHealth {
    const binaryPath = this.runtime.engineBinaryPath?.() ?? null;
    return {
      runtime: this.runtime.kind,
      binaryPath,
      // A runtime without a binary (fake) is always "present".
      binaryPresent: binaryPath === null || fs.existsSync(binaryPath),
      installs: this.scanInstalls(),
    };
  }

  async selfTest(): Promise<EngineSelfTestResult> {
    const started = Date.now();
    const scratchDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "queuepilot-selftest-"),
    );
    const syntheticProfile: Profile = {
      id: randomUUID(),
      name: "engine-self-test",
      group: "default",
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
    try {
      const session = await this.runtime.launch({
        profile: syntheticProfile,
        identity: null,
        proxyUrl: null,
        profileDataDir: scratchProfileDir(scratchDir),
      });
      await session.stop();
      return {
        ok: true,
        runtime: this.runtime.kind,
        latencyMs: Date.now() - started,
        error: null,
      };
    } catch (err) {
      return {
        ok: false,
        runtime: this.runtime.kind,
        latencyMs: null,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  }

  /** Verified install receipts under <dataDir>/engines/<kind>/<version>/<platform>/install.json. */
  private scanInstalls(): InstalledEngine[] {
    const root = path.join(this.dataDir, "engines");
    const found: InstalledEngine[] = [];
    if (!fs.existsSync(root)) return found;
    for (const kind of safeReaddir(root)) {
      for (const version of safeReaddir(path.join(root, kind))) {
        for (const platform of safeReaddir(path.join(root, kind, version))) {
          const receipt = path.join(
            root,
            kind,
            version,
            platform,
            "install.json",
          );
          if (!fs.existsSync(receipt)) continue;
          try {
            found.push(
              InstalledEngineSchema.parse(
                JSON.parse(fs.readFileSync(receipt, "utf8")),
              ),
            );
          } catch {
            // A corrupt receipt means "not verifiably installed" — the
            // installer already treats it the same way.
          }
        }
      }
    }
    return found;
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function scratchProfileDir(scratchDir: string): string {
  const dir = path.join(scratchDir, "profile");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
