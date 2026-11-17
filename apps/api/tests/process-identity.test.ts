import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import type { BrowserRun } from "@queuepilot/contracts";
import {
  captureProcessStartToken,
  checkProcessIdentity,
  startTokenForRun,
} from "../src/infrastructure/process-inventory.js";
import { makeTestContext, type TestContext } from "./helpers.js";

/**
 * D-002 follow-ups. Like process-inventory.test.ts these use REAL child
 * processes: a sleeper plays the engine that outlived an API restart, and a
 * wrong token against its live PID is the PID-reuse case.
 */

const children: ChildProcess[] = [];

export function spawnSleeper(): ChildProcess {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
    stdio: "ignore",
  });
  children.push(child);
  return child;
}

afterEach(() => {
  for (const c of children.splice(0)) c.kill();
});

/**
 * Simulate "the API restarted while this profile's engine kept running":
 * launch on the fake runtime, point the run row at a real process, and drop
 * the in-memory session (a fresh API process has none).
 */
export async function adoptedRun(
  ctx: TestContext,
  name: string,
  pid: number,
  processToken: string | null,
  extra: Partial<BrowserRun> = {},
): Promise<{ profileId: string; run: BrowserRun }> {
  const p = ctx.profiles.create({ name, generateFingerprint: true });
  const started = await ctx.lifecycle.start(p.id);
  const run: BrowserRun = { ...started, pid, processToken, ...extra };
  ctx.lifecycle["runs"].update(run);
  ctx.lifecycle["sessions"].clear();
  return { profileId: p.id, run };
}

describe("checkProcessIdentity", () => {
  it("separates proven, disproven, unprovable and dead", () => {
    const child = spawnSleeper();
    const token = captureProcessStartToken(child.pid!);
    expect(token).toBeTruthy();
    expect(checkProcessIdentity(child.pid!, token)).toBe("match");
    expect(checkProcessIdentity(child.pid!, "2020-01-01T00:00:00Z")).toBe("mismatch");
    // No stored token: alive, but nothing to prove identity with.
    expect(checkProcessIdentity(child.pid!, null)).toBe("unknown");
    expect(checkProcessIdentity(child.pid!)).toBe("unknown");
  });

  it("answers dead for missing, invalid and exited pids", async () => {
    expect(checkProcessIdentity(null, "x")).toBe("dead");
    expect(checkProcessIdentity(0, "x")).toBe("dead");
    expect(checkProcessIdentity(-1)).toBe("dead");
    expect(checkProcessIdentity(1.5)).toBe("dead");
    const child = spawnSleeper();
    const token = captureProcessStartToken(child.pid!);
    const gone = new Promise((r) => child.once("exit", r));
    child.kill();
    await gone;
    expect(checkProcessIdentity(child.pid!, token)).toBe("dead");
  });
});

describe("startTokenForRun (launch capture)", () => {
  it("keeps the token of a process started after the run row was written", () => {
    const runStartedAt = new Date().toISOString();
    const child = spawnSleeper();
    expect(startTokenForRun(child.pid!, runStartedAt)).toBe(
      captureProcessStartToken(child.pid!),
    );
  });

  it("drops the token of a process that predates the run (PID inherited by a stranger)", () => {
    const child = spawnSleeper();
    expect(captureProcessStartToken(child.pid!)).toBeTruthy();
    // The run "started" an hour after this process did: not our engine.
    const later = new Date(Date.now() + 3_600_000).toISOString();
    expect(startTokenForRun(child.pid!, later)).toBeNull();
  });

  it("returns null when there is no such process", () => {
    expect(startTokenForRun(-1, new Date().toISOString())).toBeNull();
  });
});

describe("reconcileOnBoot by start token", () => {
  it("adopts a live engine whose token matches, as verified", async () => {
    const ctx = makeTestContext();
    const child = spawnSleeper();
    const { profileId, run } = await adoptedRun(
      ctx,
      "match",
      child.pid!,
      captureProcessStartToken(child.pid!),
    );
    expect(ctx.lifecycle.reconcileOnBoot()).toEqual({ adopted: 1, crashed: 0, unverified: 0 });
    expect(ctx.lifecycle.activeRun(profileId)?.id).toBe(run.id);
  });

  it("marks a reused PID crashed and leaves the stranger running", async () => {
    const ctx = makeTestContext();
    const child = spawnSleeper();
    const { profileId, run } = await adoptedRun(ctx, "reused", child.pid!, "2020-01-01T00:00:00Z");
    expect(ctx.lifecycle.reconcileOnBoot()).toEqual({ adopted: 0, crashed: 1, unverified: 0 });
    const after = ctx.lifecycle.listRuns(profileId).find((r) => r.id === run.id);
    expect(after?.status).toBe("crashed");
    expect(after?.lastError).toMatch(/reused/);
    expect(ctx.lifecycle.activeRun(profileId)).toBeNull();
    expect(ctx.profiles.get(profileId).status).toBe("idle");
    // Reconciliation never kills: the stranger that owns the PID is untouched.
    expect(checkProcessIdentity(child.pid!)).toBe("unknown");
  });

  it("adopts a tokenless run but counts it as unverified, and /metrics shows it", async () => {
    const ctx = makeTestContext();
    const child = spawnSleeper();
    await adoptedRun(ctx, "tokenless", child.pid!, null);
    expect(ctx.lifecycle.reconcileOnBoot()).toEqual({ adopted: 1, crashed: 0, unverified: 1 });
    const metrics = (await ctx.app.inject({ method: "GET", url: "/metrics" })).json();
    expect(metrics).toMatchObject({
      runsAdopted: 1,
      runsAdoptedUnverified: 1,
      runsReconciledCrashed: 0,
    });
  });
});
