import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import type { BrowserRun } from "@queuepilot/contracts";
import {
  captureProcessStartToken,
  checkProcessIdentity,
} from "../src/infrastructure/process-inventory.js";
import { makeTestContext, type TestContext } from "./helpers.js";
import { MockCdpServer } from "./helpers/mock-cdp-server.js";

/**
 * D-002 follow-up: Stop on a run adopted after an API restart. There is no
 * session handle, only a PID — so these tests use REAL child processes and
 * assert on whether the process is actually gone afterwards. The rule under
 * test: kill by PID only when the start token proves the process is ours.
 */

const children: ChildProcess[] = [];

function spawnSleeper(): ChildProcess {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
    stdio: "ignore",
  });
  children.push(child);
  return child;
}

afterEach(() => {
  for (const c of children.splice(0)) c.kill();
});

/** A running profile whose row points at `pid`, with no in-memory session. */
async function adoptedRun(
  ctx: TestContext,
  pid: number,
  processToken: string | null,
  wsEndpoint?: string,
): Promise<{ profileId: string; run: BrowserRun }> {
  const p = ctx.profiles.create({ name: `adopted-${pid}`, generateFingerprint: true });
  const started = await ctx.lifecycle.start(p.id);
  const run: BrowserRun = {
    ...started,
    pid,
    processToken,
    wsEndpoint: wsEndpoint ?? started.wsEndpoint,
  };
  ctx.lifecycle["runs"].update(run);
  ctx.lifecycle["sessions"].clear();
  // Keep escalation windows short: a sleeper has no window to WM_CLOSE.
  ctx.lifecycle["adoptedStopGraceMs"] = 1_500;
  return { profileId: p.id, run };
}

const alive = (pid: number) => checkProcessIdentity(pid) !== "dead";

// Real processes + blocking OS start-time reads + kill escalation windows:
// ~10 s alone, can pass 30 s under a loaded full run.
describe("stop() on an adopted run", { timeout: 60_000 }, () => {
  it("right token: the engine process is actually terminated", async () => {
    const ctx = makeTestContext();
    const child = spawnSleeper();
    const { profileId } = await adoptedRun(ctx, child.pid!, captureProcessStartToken(child.pid!));

    const stopped = await ctx.lifecycle.stop(profileId);

    expect(stopped?.status).toBe("stopped");
    expect(stopped?.lastError).toBeNull();
    expect(alive(child.pid!)).toBe(false);
    expect(ctx.lifecycle.activeRun(profileId)).toBeNull();
    expect(ctx.profiles.get(profileId).status).toBe("idle");
  });

  it("wrong token (PID reused): the stranger survives and the row says why", async () => {
    const ctx = makeTestContext();
    const child = spawnSleeper();
    const { profileId } = await adoptedRun(ctx, child.pid!, "2020-01-01T00:00:00Z");

    const stopped = await ctx.lifecycle.stop(profileId);

    expect(stopped?.status).toBe("stopped");
    expect(stopped?.lastError).toMatch(/reused by another process/);
    expect(alive(child.pid!)).toBe(true);
    // The profile is free again either way — Stop never leaves it stuck.
    expect(ctx.lifecycle.activeRun(profileId)).toBeNull();
    expect(ctx.profiles.get(profileId).status).toBe("idle");
  });

  it("missing token: never killed by PID, and the row says it may still be running", async () => {
    const ctx = makeTestContext();
    const child = spawnSleeper();
    const { profileId, run } = await adoptedRun(ctx, child.pid!, null);

    const stopped = await ctx.lifecycle.stop(profileId);

    expect(stopped?.status).toBe("stopped");
    expect(stopped?.lastError).toMatch(/may still be running/);
    expect(stopped?.lastError).toMatch(/not killed by PID/);
    expect(alive(child.pid!)).toBe(true);
    // Persisted, not just returned.
    expect(ctx.lifecycle.listRuns(profileId).find((r) => r.id === run.id)?.lastError).toMatch(
      /may still be running/,
    );
  });

  it("missing token + live DevTools endpoint: Browser.close shuts it down cleanly", async () => {
    const ctx = makeTestContext();
    const cdp = new MockCdpServer();
    const { wsUrl } = await cdp.start();
    const child = spawnSleeper();
    // The mock records Browser.close; this plays the browser honoring it.
    const honor = setInterval(() => {
      if (cdp.callsFor("Browser.close").length > 0) child.kill();
    }, 25);
    try {
      const { profileId } = await adoptedRun(ctx, child.pid!, null, wsUrl);

      const stopped = await ctx.lifecycle.stop(profileId);

      expect(cdp.callsFor("Browser.close")).toHaveLength(1);
      expect(stopped?.status).toBe("stopped");
      expect(stopped?.lastError).toBeNull();
      expect(alive(child.pid!)).toBe(false);
      // The server side of the socket closes a tick after the client does.
      await vi.waitFor(() => expect(cdp.openConnectionCount).toBe(0));
    } finally {
      clearInterval(honor);
      await cdp.stop();
    }
  });

  it("right token + endpoint that ignores Browser.close: identity re-proven, then killed by PID", async () => {
    const ctx = makeTestContext();
    const cdp = new MockCdpServer(); // answers Browser.close but nothing exits
    const { wsUrl } = await cdp.start();
    const child = spawnSleeper();
    try {
      const { profileId } = await adoptedRun(
        ctx,
        child.pid!,
        captureProcessStartToken(child.pid!),
        wsUrl,
      );

      const stopped = await ctx.lifecycle.stop(profileId);

      expect(cdp.callsFor("Browser.close")).toHaveLength(1);
      expect(stopped?.lastError).toBeNull();
      expect(alive(child.pid!)).toBe(false);
    } finally {
      await cdp.stop();
    }
  });

  it("engine already gone: a plain idempotent stop, no note", async () => {
    const ctx = makeTestContext();
    const child = spawnSleeper();
    const token = captureProcessStartToken(child.pid!);
    const { profileId } = await adoptedRun(ctx, child.pid!, token);
    const gone = new Promise((r) => child.once("exit", r));
    child.kill();
    await gone;

    const stopped = await ctx.lifecycle.stop(profileId);

    expect(stopped?.status).toBe("stopped");
    expect(stopped?.lastError).toBeNull();
    expect(await ctx.lifecycle.stop(profileId)).toBeNull(); // second stop: no-op
  });
});
