import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { QueuePilotClient } from "@queuepilot/client";
import { runScript } from "../src/cli/script-runner.js";

/**
 * Script runner CLI: `queuepilot script <file.mjs> --profile <id>`.
 * The client is injected (a stub subclass) so the runner's behavior — script
 * loading, borrow-don't-own start semantics, exit codes — is tested without
 * a server. Real .mjs fixtures are written to a temp dir because the runner
 * loads scripts via dynamic import of a file URL.
 */
class StubClient extends QueuePilotClient {
  activeRunResult: { run: unknown } = { run: null };
  startResult: unknown = null;
  startCalls = 0;

  constructor() {
    super("http://127.0.0.1:1");
  }

  override async activeRun(): Promise<{ run: never }> {
    return this.activeRunResult as { run: never };
  }

  override async start(): Promise<never> {
    this.startCalls++;
    return this.startResult as never;
  }
}

const liveRun = {
  id: "r1",
  profileId: "p1",
  status: "running",
  pid: 4321,
  debugPort: 9222,
  wsEndpoint: "ws://127.0.0.1:9222/devtools/browser/x",
  startedAt: new Date().toISOString(),
  stoppedAt: null,
  lastError: null,
};

function writeScript(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "queuepilot-script-"));
  const file = path.join(dir, "script.mjs");
  fs.writeFileSync(file, body);
  return file;
}

describe("script runner CLI", () => {
  it("prints usage and exits 2 without script path or profile", async () => {
    const lines: string[] = [];
    expect(await runScript([], { log: (m) => lines.push(m) })).toBe(2);
    expect(lines[0]).toMatch(/usage: queuepilot script/);
  });

  it("borrows the running session and never starts or stops", async () => {
    const client = new StubClient();
    client.activeRunResult = { run: liveRun };
    const file = writeScript(
      "export default async (ctx) => ({ ws: ctx.wsEndpoint, profile: ctx.profileId });",
    );
    const lines: string[] = [];
    const code = await runScript([file, "--profile", "p1"], {
      client,
      log: (m) => lines.push(m),
    });
    expect(code).toBe(0);
    expect(client.startCalls).toBe(0);
    expect(JSON.parse(lines[0]!)).toEqual({
      ws: liveRun.wsEndpoint,
      profile: "p1",
    });
  });

  it("starts the profile when it is not running", async () => {
    const client = new StubClient();
    client.startResult = liveRun;
    const file = writeScript("export default async () => ({ ok: true });");
    const code = await runScript([file, "--profile", "p1"], {
      client,
      log: () => {},
    });
    expect(code).toBe(0);
    expect(client.startCalls).toBe(1);
  });

  it("exits 2 when the script has no default-exported function", async () => {
    const file = writeScript("export const notDefault = 1;");
    const lines: string[] = [];
    const code = await runScript([file, "--profile", "p1"], {
      client: new StubClient(),
      log: (m) => lines.push(m),
    });
    expect(code).toBe(2);
    expect(lines[0]).toMatch(/default export/);
  });

  it("exits 1 with the stable error code when the script throws", async () => {
    const client = new StubClient();
    client.activeRunResult = { run: liveRun };
    // A plain Error carrying a `code` (the shape ApiError has) — the temp
    // script can't import @queuepilot/client from the OS temp dir.
    const file = writeScript(
      "export default async () => { const e = new Error('no run'); e.code = 'PROFILE_NOT_RUNNING'; throw e; };",
    );
    const lines: string[] = [];
    const code = await runScript([file, "--profile", "p1"], {
      client,
      log: (m) => lines.push(m),
    });
    expect(code).toBe(1);
    expect(lines[0]).toContain("[PROFILE_NOT_RUNNING]");
  });

  it("exits 1 when the engine gave no ws endpoint", async () => {
    const client = new StubClient();
    client.activeRunResult = { run: { ...liveRun, wsEndpoint: null } };
    const file = writeScript("export default async () => ({ ok: true });");
    const lines: string[] = [];
    const code = await runScript([file, "--profile", "p1"], {
      client,
      log: (m) => lines.push(m),
    });
    expect(code).toBe(1);
    expect(lines[0]).toContain("no ws endpoint");
  });
});
