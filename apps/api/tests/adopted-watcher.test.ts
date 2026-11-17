import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import type { BrowserRun, LifecycleEvent } from "@queuepilot/contracts";
import { captureProcessStartToken } from "../src/infrastructure/process-inventory.js";
import { makeTestContext, type TestContext } from "./helpers.js";

/**
 * D-002 follow-up: runs adopted after an API restart are re-checked on a
 * timer, so a dead (or PID-reused) engine stops reading "running". Real
 * child processes play the adopted engines.
 */

const children: ChildProcess[] = [];
const contexts: TestContext[] = [];

function spawnSleeper(): ChildProcess {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
    stdio: "ignore",
  });
  children.push(child);
  return child;
}

function context(): TestContext {
  const ctx = makeTestContext();
  ctx.lifecycle["adoptedWatchIntervalMs"] = 100;
  contexts.push(ctx);
  return ctx;
}

afterEach(() => {
  for (const ctx of contexts.splice(0)) ctx.lifecycle.stopAdoptedWatcher();
  for (const c of children.splice(0)) c.kill();
});

async function adoptedRun(
  ctx: TestContext,
  name: string,
  pid: number,
  processToken: string | null,
): Promise<{ profileId: string; run: BrowserRun }> {
  const p = ctx.profiles.create({ name, generateFingerprint: true });
  const started = await ctx.lifecycle.start(p.id);
  const run: BrowserRun = { ...started, pid, processToken };
  ctx.lifecycle["runs"].update(run);
  ctx.lifecycle["sessions"].delete(p.id);
  return { profileId: p.id, run };
}

function nextCrash(ctx: TestContext, timeoutMs = 5_000): Promise<LifecycleEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no run.crashed event")), timeoutMs);
    ctx.lifecycle.events.on("lifecycle", (e: LifecycleEvent) => {
      if (e.type !== "run.crashed") return;
      clearTimeout(timer);
      resolve(e);
    });
  });
}

describe("adopted-run watcher", () => {
  it("marks an adopted run crashed when its engine dies, and leaves a healthy one alone", async () => {
    const ctx = context();
    const doomed = spawnSleeper();
    const healthy = spawnSleeper();
    const a = await adoptedRun(ctx, "doomed", doomed.pid!, captureProcessStartToken(doomed.pid!));
    const b = await adoptedRun(ctx, "healthy", healthy.pid!, captureProcessStartToken(healthy.pid!));
    expect(ctx.lifecycle.reconcileOnBoot()).toMatchObject({ adopted: 2, crashed: 0 });

    const crash = nextCrash(ctx);
    doomed.kill();
    const event = await crash;

    expect(event.profileId).toBe(a.profileId);
    expect(event.runId).toBe(a.run.id);
    const after = ctx.lifecycle.listRuns(a.profileId).find((r) => r.id === a.run.id);
    expect(after?.status).toBe("crashed");
    expect(after?.lastError).toMatch(/adopted engine process exited/);
    expect(ctx.profiles.get(a.profileId).status).toBe("idle");
    // The healthy adopted run is still occupying and still watched.
    expect(ctx.lifecycle.activeRun(b.profileId)?.id).toBe(b.run.id);
    expect(ctx.lifecycle["adoptedWatcher"]).not.toBeNull();
    expect(ctx.lifecycle.recoveryCounters.runsReconciledCrashed).toBe(1);
  });

  it("detects PID reuse on an identity pass, and stops itself when nothing is adopted", async () => {
    const ctx = context();
    const child = spawnSleeper();
    const { profileId, run } = await adoptedRun(
      ctx,
      "reused-later",
      child.pid!,
      captureProcessStartToken(child.pid!),
    );
    ctx.lifecycle.reconcileOnBoot();
    ctx.lifecycle.stopAdoptedWatcher(); // drive the passes by hand below
    // The engine "died" and a stranger now holds its PID: same PID, alive,
    // different start time.
    ctx.lifecycle["runs"].update({ ...run, processToken: "2020-01-01T00:00:00Z" });

    expect(ctx.lifecycle.checkAdoptedRuns(false)).toBe(0); // liveness alone cannot see it
    expect(ctx.lifecycle.checkAdoptedRuns(true)).toBe(1);

    const after = ctx.lifecycle.listRuns(profileId).find((r) => r.id === run.id);
    expect(after?.status).toBe("crashed");
    expect(after?.lastError).toMatch(/PID was reused/);
    expect(ctx.lifecycle["adoptedWatcher"]).toBeNull();
  });

  it("never touches a run that has a session or is still launching", async () => {
    const ctx = context();
    const p = ctx.profiles.create({ name: "live", generateFingerprint: true });
    const run = await ctx.lifecycle.start(p.id); // fake pid: not a real process
    expect(ctx.lifecycle.checkAdoptedRuns(true)).toBe(0);
    expect(ctx.lifecycle.activeRun(p.id)?.id).toBe(run.id);

    ctx.lifecycle["sessions"].delete(p.id);
    ctx.lifecycle["runs"].update({ ...run, status: "launching", pid: null });
    expect(ctx.lifecycle.checkAdoptedRuns(true)).toBe(0);
    expect(ctx.lifecycle.activeRun(p.id)?.status).toBe("launching");
  });

  it("does not start a watcher when boot adopts nothing", () => {
    const ctx = context();
    expect(ctx.lifecycle.reconcileOnBoot()).toEqual({ adopted: 0, crashed: 0, unverified: 0 });
    expect(ctx.lifecycle["adoptedWatcher"]).toBeNull();
  });
});
