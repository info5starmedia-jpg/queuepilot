import { describe, expect, it } from "vitest";
import { BrowserLifecycleService } from "../src/application/lifecycle/browser.lifecycle.service.js";
import { ProfileRepository, FingerprintIdentityRepository } from "../src/application/profiles/profile.repository.js";
import { ProfileService } from "../src/application/profiles/profile.service.js";
import { ProxyService } from "../src/application/proxies/proxy.service.js";
import { ProxyRepository } from "../src/application/proxies/proxy.repository.js";
import { BrowserRunRepository } from "../src/application/lifecycle/browser-run.repository.js";
import { FakeBrowserRuntime } from "../src/application/runtime/fake.browser-runtime.js";
import { LaunchIdentityService } from "../src/application/lifecycle/launch-identity.service.js";
import { openTestDatabase } from "../src/infrastructure/database.js";
import type { LifecycleEvent } from "@queuepilot/contracts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Engine liveness watchdog: a fury-core engine can stay alive with its
 * DevTools server wedged (found live 2026-11-20 — the run row said
 * "running" while nothing could drive the engine). The watchdog probes each
 * session's debug port; N consecutive failures latch the run DEGRADED
 * (run.degraded event + isDegraded flag), a success clears it (run.healthy),
 * and stop/exit always clear the latch.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeCtx(probe: () => Promise<boolean>, threshold = 2) {
  const db = openTestDatabase();
  const profileRepo = new ProfileRepository(db);
  const identityRepo = new FingerprintIdentityRepository(db);
  const proxyRepo = new ProxyRepository(db);
  const runRepo = new BrowserRunRepository(db);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "qp-liveness-test-"));
  const profiles = new ProfileService(profileRepo, identityRepo, proxyRepo);
  const lifecycle = new BrowserLifecycleService(
    profileRepo,
    identityRepo,
    new ProxyService(proxyRepo),
    runRepo,
    new FakeBrowserRuntime(),
    dataDir,
    new LaunchIdentityService(dataDir),
    undefined, // leaseGuard
    undefined, // leaseRenewIntervalMs
    undefined, // rotationProviders
    undefined, // proxyGeoLookup
    undefined, // hostTimezone
    { intervalMs: 25, threshold, probe: async () => probe() },
  );
  return { profiles, lifecycle };
}

function collect(lifecycle: BrowserLifecycleService): LifecycleEvent[] {
  const events: LifecycleEvent[] = [];
  lifecycle.events.on("lifecycle", (e) => events.push(e));
  return events;
}

describe("engine liveness watchdog", () => {
  it("latches DEGRADED after the threshold of failed probes, emits once, recovers on success", async () => {
    let healthy = true;
    const ctx = makeCtx(async () => healthy, 2);
    const events = collect(ctx.lifecycle);
    const p = ctx.profiles.create({ name: "watchdog", generateFingerprint: true });
    await ctx.lifecycle.start(p.id);
    expect(ctx.lifecycle.isDegraded(p.id)).toBe(false);

    healthy = false;
    await sleep(120); // ≥ threshold(2) × interval(25ms)
    expect(ctx.lifecycle.isDegraded(p.id)).toBe(true);
    const degraded = events.filter((e) => e.type === "run.degraded");
    expect(degraded).toHaveLength(1);
    expect(degraded[0]!.profileId).toBe(p.id);

    await sleep(120); // more failures while latched: no repeat event
    expect(events.filter((e) => e.type === "run.degraded")).toHaveLength(1);

    healthy = true;
    await sleep(60);
    expect(ctx.lifecycle.isDegraded(p.id)).toBe(false);
    expect(events.filter((e) => e.type === "run.healthy")).toHaveLength(1);

    await ctx.lifecycle.stop(p.id);
  });

  it("never latches below the failure threshold", async () => {
    let calls = 0;
    const ctx = makeCtx(async () => {
      calls++;
      return calls < 2; // exactly one failure, then healthy again
    }, 3);
    const events = collect(ctx.lifecycle);
    const p = ctx.profiles.create({ name: "below-threshold", generateFingerprint: true });
    await ctx.lifecycle.start(p.id);
    await sleep(100);
    expect(ctx.lifecycle.isDegraded(p.id)).toBe(false);
    expect(events.filter((e) => e.type === "run.degraded")).toHaveLength(0);
    await ctx.lifecycle.stop(p.id);
  });

  it("stop() clears the degraded latch for the run", async () => {
    const ctx = makeCtx(async () => false, 1);
    const events = collect(ctx.lifecycle);
    const p = ctx.profiles.create({ name: "stop-clears", generateFingerprint: true });
    await ctx.lifecycle.start(p.id);
    await sleep(60);
    expect(ctx.lifecycle.isDegraded(p.id)).toBe(true);
    await ctx.lifecycle.stop(p.id);
    expect(ctx.lifecycle.isDegraded(p.id)).toBe(false);
    expect(events.filter((e) => e.type === "run.degraded")).toHaveLength(1);
  });
});
