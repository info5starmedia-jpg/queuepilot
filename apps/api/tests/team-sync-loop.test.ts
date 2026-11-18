import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { buildTeamServerApp, type TeamServerApp } from "@queuepilot/server";
import { BundleService } from "../src/application/bundles/bundle.service.js";
import type { BundleCookie } from "../src/application/bundles/session-bundle.js";
import { TeamServerClient } from "../src/application/team/team-client.js";
import { TeamSyncService } from "../src/application/team/team-sync.js";
import { TeamSyncLoop } from "../src/application/team/team-sync-loop.js";
import { makeTestContext } from "./helpers.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * P7.7c — the background sync loop. Machine A pushes a sealed bundle; machine
 * B's loop (configured via Settings → Team) pulls it on tick, records the
 * revision watermark, and skips it on later ticks. A misconfigured machine
 * no-ops.
 *
 * v0.15.0 (audit B2): metadata imports immediately, but the watermark only
 * advances once the bundle's cookies have actually landed in an engine —
 * before this, the loop advanced the watermark with the cookies still inside
 * the bundle, so profiles looked synced while their cookies never arrived.
 */

const PASSPHRASE = "family-shared-secret";
const COOKIES: BundleCookie[] = [
  { name: "session", value: "xyz", domain: ".example.com", path: "/", expires: 0, secure: true, httpOnly: true },
];

describe("TeamSyncLoop", () => {
  let server: TeamServerApp;
  let base: string;

  beforeEach(async () => {
    server = buildTeamServerApp({
      host: "127.0.0.1",
      port: 0,
      dbPath: ":memory:",
      adminToken: "bootstrap-secret",
      machineName: "test",
    });
    await server.app.listen({ host: "127.0.0.1", port: 0 });
    const { port } = server.app.server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await server.close();
  });

  function pusher() {
    const ctx = makeTestContext();
    const bundles = new BundleService(ctx.profiles, ctx.lifecycle, {
      export: async () => COOKIES,
      import: async () => {},
    }, ctx.proxies);
    const sync = new TeamSyncService(bundles, new TeamServerClient(base, "bootstrap-secret"));
    /** Create + start + push + stop — exports need the live engine. */
    async function pushFresh(name: string): Promise<void> {
      const p = ctx.profiles.create({ name, generateFingerprint: true });
      await ctx.lifecycle.start(p.id);
      await sync.pushProfile(p.id, PASSPHRASE);
      await ctx.lifecycle.stop(p.id);
    }
    return { ctx, sync, pushFresh };
  }

  function loopMachine(opts: { configured: boolean }) {
    const ctx = makeTestContext();
    const bundles = new BundleService(ctx.profiles, ctx.lifecycle, {
      export: async () => [],
      import: async () => {},
    }, ctx.proxies);
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "qp-sync-loop-"));
    // makeTestContext exposes settings; configure team if asked.
    if (opts.configured) {
      ctx.settings.patch("team", {
        serverUrl: base,
        token: "bootstrap-secret",
        syncPassphrase: PASSPHRASE,
      });
    }
    const loop = new TeamSyncLoop({
      bundles,
      settings: ctx.settings,
      dataDir,
    });
    return { ctx, loop };
  }

  it("imports metadata on tick, holds the watermark until the engine is live, then finishes (audit B2)", async () => {
    const a = pusher();
    await a.pushFresh("loop-src");

    const b = loopMachine({ configured: true });
    // First tick: the profile lands on machine B, but its cookies are still
    // inside the bundle (engine not running) — the watermark must NOT advance.
    const first = await b.loop.tick();
    expect(first.enabled).toBe(true);
    expect(first.checked).toBe(1);
    expect(first.imported).toBe(0);
    expect(first.pending).toBe(1);
    expect(b.ctx.profiles.list().map((x) => x.name)).toContain("loop-src");

    // Engine comes live: the next tick finishes the cookie import and only
    // NOW advances the watermark.
    const local = b.ctx.profiles.list().find((x) => x.name === "loop-src")!;
    await b.ctx.lifecycle.start(local.id);
    const second = await b.loop.tick();
    expect(second.imported).toBe(1);
    expect(second.pending).toBe(0);

    // Watermark recorded — later ticks skip the profile entirely.
    const third = await b.loop.tick();
    expect(third.imported).toBe(0);
    expect(third.pending).toBe(0);
    expect(b.ctx.profiles.list()).toHaveLength(1);
  });

  it("unconfigured machine no-ops (enabled: false, nothing pulled)", async () => {
    const a = pusher();
    await a.pushFresh("loop-nocfg");

    const b = loopMachine({ configured: false });
    const res = await b.loop.tick();
    expect(res).toEqual({ enabled: false, checked: 0, imported: 0, pending: 0, failed: 0, skipped: 0 });
    expect(b.ctx.profiles.list()).toHaveLength(0);
  });

  it("a failing pull counts as failed and does not advance the watermark", async () => {
    // Configure a machine whose passphrase is WRONG — every pull fails.
    const a = pusher();
    await a.pushFresh("loop-badpass");

    const b = loopMachine({ configured: true });
    b.ctx.settings.patch("team", { syncPassphrase: "wrong-passphrase" });
    const res = await b.loop.tick();
    expect(res.failed).toBe(1);
    expect(res.imported).toBe(0);

    // fix the passphrase: the next tick retries (watermark never advanced)
    b.ctx.settings.patch("team", { syncPassphrase: PASSPHRASE });
    const retry = await b.loop.tick();
    expect(retry.failed).toBe(0);
    expect(retry.pending).toBe(1); // cookies held — engine not running yet
    const local = b.ctx.profiles.list().find((x) => x.name === "loop-badpass")!;
    await b.ctx.lifecycle.start(local.id);
    const finish = await b.loop.tick();
    expect(finish.imported).toBe(1);
    expect(b.ctx.profiles.list().map((x) => x.name)).toContain("loop-badpass");
  });

  it("persists the watermark across loop instances (restart-safe)", async () => {
    const a = pusher();
    await a.pushFresh("loop-restart");

    const ctx = makeTestContext();
    ctx.settings.patch("team", { serverUrl: base, token: "bootstrap-secret", syncPassphrase: PASSPHRASE });
    const bundles = new BundleService(ctx.profiles, ctx.lifecycle, {
      export: async () => [],
      import: async () => {},
    }, ctx.proxies);
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "qp-sync-loop-"));
    const first = new TeamSyncLoop({ bundles, settings: ctx.settings, dataDir });
    // metadata in, cookies pending (engine not running) — watermark held back
    expect(await first.tick()).toMatchObject({ imported: 0, pending: 1 });

    // finish the import so the watermark can advance
    const local = ctx.profiles.list()[0]!;
    await ctx.lifecycle.start(local.id);
    expect(await first.tick()).toMatchObject({ imported: 1, pending: 0 });

    // "restart": a fresh loop over the same dataDir must not re-import
    const second = new TeamSyncLoop({ bundles, settings: ctx.settings, dataDir });
    expect((await second.tick()).imported).toBe(0);
  });
});
