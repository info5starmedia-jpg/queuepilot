import { describe, expect, it } from "vitest";
import { ErrorCodes, type DomainError } from "@queuepilot/contracts";
import { makeTestContext } from "./helpers.js";

/**
 * The lifecycle guarantees, tested against the fake engine:
 * double-launch protection, durable run rows, crash handling,
 * idempotent stop, and boot-time reconciliation.
 */
describe("BrowserLifecycleService", () => {
  it("starts a run and records pid/port/ws durably", async () => {
    const { lifecycle, profiles } = makeTestContext();
    const p = profiles.create({ name: "run-me", generateFingerprint: true });
    const run = await lifecycle.start(p.id);
    expect(run.status).toBe("running");
    expect(run.pid).toBeGreaterThan(0);
    expect(run.wsEndpoint).toContain("ws://127.0.0.1");
    expect(profiles.get(p.id).status).toBe("running");
  });

  it("rejects a second concurrent launch — the double-launch guard", async () => {
    const { lifecycle, profiles } = makeTestContext();
    const p = profiles.create({ name: "race", generateFingerprint: true });
    const first = await lifecycle.start(p.id);
    await expect(lifecycle.start(p.id)).rejects.toMatchObject({
      code: ErrorCodes.PROFILE_ALREADY_RUNNING,
    });
    // The first run is untouched.
    expect(lifecycle.activeRun(p.id)?.id).toBe(first.id);
  });

  it("serializes a burst of parallel starts into exactly one winner", async () => {
    const { lifecycle, profiles } = makeTestContext();
    const p = profiles.create({ name: "burst", generateFingerprint: true });
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => lifecycle.start(p.id)),
    );
    const ok = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(rejected).toHaveLength(9);
    for (const r of rejected) {
      expect((r as PromiseRejectedResult).reason.code).toBe(ErrorCodes.PROFILE_ALREADY_RUNNING);
    }
  });

  it("marks a crashed run and frees the profile for relaunch", async () => {
    const { lifecycle, profiles, runtime } = makeTestContext();
    const p = profiles.create({ name: "crashy", generateFingerprint: true });
    const run = await lifecycle.start(p.id);
    const session = runtime.sessions.find((s) => s.profileId === p.id)!;
    session.crash();
    // Let the exit handler run.
    await new Promise((r) => setTimeout(r, 10));
    expect(lifecycle.activeRun(p.id)).toBeNull();
    expect(profiles.get(p.id).status).toBe("error");
    const history = lifecycle.listRuns(p.id);
    expect(history.find((r) => r.id === run.id)?.status).toBe("crashed");
    // And the profile can start again.
    const second = await lifecycle.start(p.id);
    expect(second.status).toBe("running");
  });

  it("stop is idempotent — stopping a stopped profile is a no-op", async () => {
    const { lifecycle, profiles } = makeTestContext();
    const p = profiles.create({ name: "stopper", generateFingerprint: true });
    await lifecycle.start(p.id);
    const stopped = await lifecycle.stop(p.id);
    expect(stopped?.status).toBe("stopped");
    const again = await lifecycle.stop(p.id);
    expect(again).toBeNull();
    expect(profiles.get(p.id).status).toBe("idle");
  });

  it("marks a failed launch crashed and reports ENGINE_LAUNCH_FAILED", async () => {
    const { lifecycle, profiles, runtime } = makeTestContext();
    const p = profiles.create({ name: "no-engine", generateFingerprint: true });
    runtime.failNextLaunch = "binary missing";
    await expect(lifecycle.start(p.id)).rejects.toMatchObject({
      code: ErrorCodes.ENGINE_LAUNCH_FAILED,
    });
    // The profile is not stuck in a half-launched state.
    expect(lifecycle.activeRun(p.id)).toBeNull();
    expect(profiles.get(p.id).status).toBe("error");
  });

  it("reconcileOnBoot marks orphaned occupying runs crashed", async () => {
    const { lifecycle, profiles } = makeTestContext();
    const p = profiles.create({ name: "orphan", generateFingerprint: true });
    const run = await lifecycle.start(p.id);
    // Simulate the API dying: the fake engine keeps "running" but a fresh
    // lifecycle (as after a restart) sees only the DB. We emulate a dead PID.
    const dead = { ...run, pid: 999_999 };
    lifecycle["runs"].update(dead);
    const recovered = lifecycle.reconcileOnBoot();
    expect(recovered.crashed).toBe(1);
    expect(lifecycle.listRuns(p.id).find((r) => r.id === run.id)?.status).toBe("crashed");
  });

  it("rejects lifecycle ops on unknown profiles", async () => {
    const { lifecycle } = makeTestContext();
    const ghost = "3f6b0e62-2c2c-4c2c-9c2c-2c2c2c2c2c2c";
    await expect(lifecycle.start(ghost)).rejects.toMatchObject({
      code: ErrorCodes.PROFILE_NOT_FOUND,
    });
  });
});

describe("lifecycle events", () => {
  it("publishes run.started and run.stopped on the event bus", async () => {
    const { lifecycle, profiles } = makeTestContext();
    const seen: string[] = [];
    lifecycle.events.on("lifecycle", (e: { type: string }) => seen.push(e.type));
    const p = profiles.create({ name: "events", generateFingerprint: true });
    await lifecycle.start(p.id);
    await lifecycle.stop(p.id);
    expect(seen).toEqual(["run.started", "run.stopped"]);
  });
});

// Type-level assertion that DomainError codes stay a closed set.
const _codeCheck: DomainError["code"] = ErrorCodes.CONFLICT;
