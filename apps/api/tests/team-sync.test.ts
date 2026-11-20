import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { ErrorCodes } from "@queuepilot/contracts";
import { buildTeamServerApp, type TeamServerApp } from "@queuepilot/server";
import { BundleService } from "../src/application/bundles/bundle.service.js";
import type { BundleCookie } from "../src/application/bundles/session-bundle.js";
import { TeamServerClient } from "../src/application/team/team-client.js";
import { TeamSyncService } from "../src/application/team/team-sync.js";
import { makeTestContext } from "./helpers.js";

/**
 * P7.7a e2e — the multi-machine shape of the roadmap's goal check: a profile
 * session sealed on machine A appears on machine B, secrets intact, with
 * optimistic concurrency keeping the two machines from silently overwriting
 * each other. "Machines" are two independent API contexts (own SQLite, own
 * dataDir, own fake engine) against ONE live team server.
 */

const PASSPHRASE = "family-shared-secret";

const COOKIES: BundleCookie[] = [
  {
    name: "session",
    value: "abc123",
    domain: ".example.com",
    path: "/",
    expires: 0,
    secure: true,
    httpOnly: true,
  },
];

interface Machine {
  sync: TeamSyncService;
  profiles: ReturnType<typeof makeTestContext>["profiles"];
  imported: BundleCookie[][];
  ctx: ReturnType<typeof makeTestContext>;
}

function machine(baseUrl: string, token: string): Machine {
  const ctx = makeTestContext();
  const imported: BundleCookie[][] = [];
  const bundles = new BundleService(ctx.profiles, ctx.lifecycle, {
    export: async () => COOKIES,
    import: async (_ws: string, cookies: BundleCookie[]) => {
      imported.push(cookies);
    },
  }, ctx.proxies);
  return {
    ctx,
    profiles: ctx.profiles,
    imported,
    sync: new TeamSyncService(bundles, new TeamServerClient(baseUrl, token)),
  };
}

describe("team sync — two machines, one server", () => {
  let server: TeamServerApp;
  let base: string;
  /** LIC: content needs a licence key; the bootstrap admin key has no content access. */
  let KEY: string;

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
    KEY = server.store.mintToken("test-machine", "operator", server.store.ensureLegacyAccount()).token;
  });

  afterEach(async () => {
    await server.close();
  });

  it("push from A, pull on B: profile appears, cookies land in B's engine", async () => {
    const a = machine(base, KEY);
    const b = machine(base, KEY);

    const onA = a.profiles.create({ name: "checkout-1", generateFingerprint: true });
    await a.ctx.lifecycle.start(onA.id);

    const pushed = await a.sync.pushProfile(onA.id, PASSPHRASE);
    expect(pushed).toEqual({ revision: 1, cookieCount: 1 });

    const pulled = await b.sync.pullProfile(PASSPHRASE, onA.id);
    expect(pulled.revision).toBe(1);
    expect(pulled.created).toBe(true);
    expect(pulled.cookiesImported).toBe(1);
    // The session arrived inside B's running engine.
    expect(b.imported[0]).toEqual(COOKIES);
    const onB = b.profiles.get(pulled.profileId);
    expect(onB.name).toBe("checkout-1");
    expect(onB.status).toBe("running");
  });

  it("re-pull upserts by name instead of duplicating", async () => {
    const a = machine(base, KEY);
    const b = machine(base, KEY);
    const onA = a.profiles.create({ name: "twice", generateFingerprint: true });
    await a.ctx.lifecycle.start(onA.id);
    await a.sync.pushProfile(onA.id, PASSPHRASE);

    const first = await b.sync.pullProfile(PASSPHRASE, onA.id);
    // Daily flow: the next pull happens after the session was closed locally.
    await b.ctx.lifecycle.stop(first.profileId);
    const second = await b.sync.pullProfile(PASSPHRASE, onA.id);
    expect(second.created).toBe(false);
    expect(second.profileId).toBe(first.profileId);
    expect(b.profiles.list().filter((p) => p.name === "twice")).toHaveLength(1);
  });

  it("stale baseRevision surfaces TEAM_REVISION_CONFLICT with the server's revision", async () => {
    const a = machine(base, KEY);
    const onA = a.profiles.create({ name: "racy", generateFingerprint: true });
    await a.ctx.lifecycle.start(onA.id);
    await a.sync.pushProfile(onA.id, PASSPHRASE); // revision 1

    try {
      await a.sync.pushProfile(onA.id, PASSPHRASE, { baseRevision: 0 });
      expect.unreachable("stale push should conflict");
    } catch (err) {
      expect((err as { code?: string }).code).toBe(ErrorCodes.TEAM_REVISION_CONFLICT);
      expect((err as { currentRevision?: number }).currentRevision).toBe(1);
    }
  });

  it("wrong passphrase on the pull side is BUNDLE_INVALID before anything is created", async () => {
    const a = machine(base, KEY);
    const b = machine(base, KEY);
    const onA = a.profiles.create({ name: "sealed", generateFingerprint: true });
    await a.ctx.lifecycle.start(onA.id);
    await a.sync.pushProfile(onA.id, PASSPHRASE);

    await expect(b.sync.pullProfile("wrong", onA.id)).rejects.toMatchObject({
      code: ErrorCodes.BUNDLE_INVALID,
    });
    expect(b.profiles.list().filter((p) => p.name === "sealed")).toHaveLength(0);
  });

  it("bad token surfaces TEAM_UNAUTHORIZED; listRemote shows heads", async () => {
    const a = machine(base, KEY);
    const onA = a.profiles.create({ name: "listed", generateFingerprint: true });
    await a.ctx.lifecycle.start(onA.id);
    await a.sync.pushProfile(onA.id, PASSPHRASE);

    const heads = await a.sync.listRemote();
    expect(heads).toEqual([
      {
        profileId: onA.id,
        revision: 1,
        updatedBy: "test-machine",
        updatedAt: expect.any(String) as unknown as string,
      },
    ]);

    const stranger = machine(base, "not-a-token");
    await expect(stranger.sync.listRemote()).rejects.toMatchObject({
      code: ErrorCodes.TEAM_UNAUTHORIZED,
    });
  });

  it("minted operator token (not the bootstrap secret) can push and pull", async () => {
    const mint = await fetch(`${base}/tokens`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer bootstrap-secret",
      },
      body: JSON.stringify({ name: "sister-laptop", role: "operator" }),
    });
    const { token } = (await mint.json()) as { token: string };

    const a = machine(base, token);
    const b = machine(base, token);
    const onA = a.profiles.create({ name: "tokenized", generateFingerprint: true });
    await a.ctx.lifecycle.start(onA.id);
    await a.sync.pushProfile(onA.id, PASSPHRASE);
    const pulled = await b.sync.pullProfile(PASSPHRASE, onA.id);
    expect(pulled.cookiesImported).toBe(1);
  });
});
