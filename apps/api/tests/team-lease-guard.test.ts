import { describe, expect, it } from "vitest";
import { DomainError, ErrorCodes } from "@queuepilot/contracts";
import { makeTestContext } from "./helpers.js";
import { BrowserLifecycleService } from "../src/application/lifecycle/browser.lifecycle.service.js";
import { ProfileRepository, FingerprintIdentityRepository } from "../src/application/profiles/profile.repository.js";
import { ProxyService } from "../src/application/proxies/proxy.service.js";
import { ProxyRepository } from "../src/application/proxies/proxy.repository.js";
import { BrowserRunRepository } from "../src/application/lifecycle/browser-run.repository.js";
import { FakeBrowserRuntime } from "../src/application/runtime/fake.browser-runtime.js";
import { LaunchIdentityService } from "../src/application/lifecycle/launch-identity.service.js";
import { ProfileService } from "../src/application/profiles/profile.service.js";
import { openTestDatabase } from "../src/infrastructure/database.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * P7.7b — the lease guard's lifecycle integration: acquire runs before the
 * launch is admitted, a denial refuses the start (TEAM_LEASE_HELD, no run
 * row left behind), a failed launch releases the lease, and stop() releases
 * the live session's lease.
 */

function makeCtx(
  guard: {
    acquire(profileId: string): Promise<void>;
    release(profileId: string): Promise<void>;
    renew?(profileId: string): Promise<void>;
  },
  renewIntervalMs?: number,
) {
  const db = openTestDatabase();
  const profileRepo = new ProfileRepository(db);
  const identityRepo = new FingerprintIdentityRepository(db);
  const proxyRepo = new ProxyRepository(db);
  const runRepo = new BrowserRunRepository(db);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "qp-lease-test-"));
  const profiles = new ProfileService(profileRepo, identityRepo, proxyRepo);
  const lifecycle = new BrowserLifecycleService(
    profileRepo,
    identityRepo,
    new ProxyService(proxyRepo),
    runRepo,
    new FakeBrowserRuntime(),
    dataDir,
    new LaunchIdentityService(dataDir),
    guard,
    renewIntervalMs,
  );
  return { profiles, lifecycle };
}

describe("lease guard in the lifecycle (P7.7b)", () => {
  it("a denied lease refuses the start with TEAM_LEASE_HELD and leaves no run", async () => {
    const calls: string[] = [];
    const ctx = makeCtx({
      async acquire(profileId) {
        calls.push(`acquire:${profileId}`);
        throw new DomainError(ErrorCodes.TEAM_LEASE_HELD, "held by machineB");
      },
      async release(profileId) {
        calls.push(`release:${profileId}`);
      },
    });
    const p = ctx.profiles.create({ name: "lease-denied", generateFingerprint: true });

    await expect(ctx.lifecycle.start(p.id)).rejects.toMatchObject({
      code: ErrorCodes.TEAM_LEASE_HELD,
    });
    expect(ctx.lifecycle.activeRun(p.id)).toBeNull();
    expect(ctx.profiles.get(p.id).status).toBe("idle");
    expect(calls).toEqual([`acquire:${p.id}`]); // no release — nothing was taken
  });

  it("an allowed start keeps the lease until stop, then releases it", async () => {
    const calls: string[] = [];
    const ctx = makeCtx({
      async acquire(profileId) {
        calls.push(`acquire:${profileId}`);
      },
      async release(profileId) {
        calls.push(`release:${profileId}`);
      },
    });
    const p = ctx.profiles.create({ name: "lease-ok", generateFingerprint: true });

    await ctx.lifecycle.start(p.id);
    expect(calls).toEqual([`acquire:${p.id}`]); // held, not released
    await ctx.lifecycle.stop(p.id);
    expect(calls).toEqual([`acquire:${p.id}`, `release:${p.id}`]);
  });

  it("a failed launch releases the lease it took", async () => {
    const calls: string[] = [];
    const runtime = new FakeBrowserRuntime();
    runtime.failNextLaunch = "engine exploded";
    const db = openTestDatabase();
    const profileRepo = new ProfileRepository(db);
    const identityRepo = new FingerprintIdentityRepository(db);
    const proxyRepo = new ProxyRepository(db);
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "qp-lease-test-"));
    const profiles = new ProfileService(profileRepo, identityRepo, proxyRepo);
    const lifecycle = new BrowserLifecycleService(
      profileRepo,
      identityRepo,
      new ProxyService(proxyRepo),
      new BrowserRunRepository(db),
      runtime,
      dataDir,
      new LaunchIdentityService(dataDir),
      {
        async acquire(id) {
          calls.push(`acquire:${id}`);
        },
        async release(id) {
          calls.push(`release:${id}`);
        },
      },
    );
    const p = profiles.create({ name: "lease-fail", generateFingerprint: true });

    await expect(lifecycle.start(p.id)).rejects.toThrow();
    expect(calls).toEqual([`acquire:${p.id}`, `release:${p.id}`]);
    expect(lifecycle.activeRun(p.id)).toBeNull();
  });

  it("renews the lease on a timer while the run is live, and stops after stop (audit B1)", async () => {
    const calls: string[] = [];
    const ctx = makeCtx(
      {
        async acquire(id) {
          calls.push(`acquire:${id}`);
        },
        async release(id) {
          calls.push(`release:${id}`);
        },
        async renew(id) {
          calls.push(`renew:${id}`);
        },
      },
      20, // fast heartbeat for the test; production default is 30 s
    );
    const p = ctx.profiles.create({ name: "lease-renew", generateFingerprint: true });

    await ctx.lifecycle.start(p.id);
    await sleep(70);
    const renewals = calls.filter((c) => c.startsWith("renew")).length;
    expect(renewals).toBeGreaterThanOrEqual(2); // heartbeat ran while live

    await ctx.lifecycle.stop(p.id);
    await sleep(50);
    expect(calls.filter((c) => c.startsWith("renew"))).toHaveLength(renewals);
    expect(calls[calls.length - 1]).toBe(`release:${p.id}`);
  });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
