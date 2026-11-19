import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { makeTestContext, TEST_IMPORTS_DIR } from "./helpers.js";

function writeTmp(name: string, content: string): string {
  // Provider sources must sit in an allowed root (audit A-rec #2) — the
  // shared test imports dir is wired as one in makeTestContext.
  fs.mkdirSync(TEST_IMPORTS_DIR, { recursive: true });
  const file = path.join(
    fs.mkdtempSync(path.join(TEST_IMPORTS_DIR, "csv-")),
    name,
  );
  fs.writeFileSync(file, content);
  return file;
}

const FILE = [
  "us-1,10.0.0.1,8080,,,",
  "us-2,10.0.0.2,8080,,,",
  "us-3,10.0.0.3,8080,,,",
].join("\n");

async function makePool(
  ctx: ReturnType<typeof makeTestContext>,
  distribution: "start-over" | "persist" | "random" = "start-over",
) {
  const file = writeTmp("proxies.txt", FILE);
  const { provider } = await ctx.proxyProviders.create({
    name: "Pool",
    sourcePath: file,
    distribution,
  });
  return provider;
}

/**
 * Proxy rotation links (D-003): a profile links to a proxy provider's pool
 * and each launch resolves an endpoint from it — rotate = per-launch pick
 * (cursor advances under start-over), persist = stable cursor entry.
 * Precedence: tempProxy > attached proxyId > proxy-list entry > rotation link
 * > direct. A link with no resolver wired refuses launch loudly.
 */
describe("proxy rotation links", () => {
  it(
    "rotate mode: each launch picks the next pool entry and snapshots proxySource=rotation",
    async () => {
      const ctx = makeTestContext();
      const { lifecycle, profiles, snapshots, proxies } = ctx;
      const provider = await makePool(ctx);
      const p = profiles.create({ name: "rot", generateFingerprint: true });
      await ctx.app.inject({
        method: "PUT",
        url: `/profiles/${p.id}/rotation-link`,
        payload: { providerId: provider.id, mode: "rotate" },
      });

      const run1 = await lifecycle.start(p.id);
      const snap1 = snapshots.forRun(run1.id)!;
      expect(snap1.proxySource).toBe("rotation");
      expect(snap1.proxyUrl).toBe("http://10.0.0.1:8080");
      expect(snap1.proxyId).toBe(
        proxies.list().find((x) => x.host === "10.0.0.1")!.id,
      );
      await lifecycle.stop(p.id);

      const run2 = await lifecycle.start(p.id);
      const snap2 = snapshots.forRun(run2.id)!;
      expect(snap2.proxySource).toBe("rotation");
      expect(snap2.proxyUrl).toBe("http://10.0.0.2:8080");
      await lifecycle.stop(p.id);
    },
    { timeout: 20000 },
  );

  it(
    "persist mode: every launch resolves the same stable pool entry",
    async () => {
      const ctx = makeTestContext();
      const { lifecycle, profiles, snapshots } = ctx;
      const provider = await makePool(ctx);
      const p = profiles.create({ name: "rot-persist", generateFingerprint: true });
      await ctx.app.inject({
        method: "PUT",
        url: `/profiles/${p.id}/rotation-link`,
        payload: { providerId: provider.id, mode: "persist" },
      });

      const run1 = await lifecycle.start(p.id);
      const url1 = snapshots.forRun(run1.id)!.proxyUrl;
      await lifecycle.stop(p.id);

      const run2 = await lifecycle.start(p.id);
      const url2 = snapshots.forRun(run2.id)!.proxyUrl;
      await lifecycle.stop(p.id);

      expect(url1).toBe("http://10.0.0.1:8080");
      expect(url2).toBe(url1);
    },
    { timeout: 20000 },
  );

  it(
    "an attached proxy beats the rotation link",
    async () => {
      const ctx = makeTestContext();
      const { lifecycle, profiles, proxies, snapshots } = ctx;
      const provider = await makePool(ctx);
      const attached = proxies.create({
        name: "attached",
        type: "http",
        host: "127.0.0.1",
        port: 8080,
      });
      const p = profiles.create({
        name: "rot-attached",
        proxyId: attached.id,
        generateFingerprint: true,
      });
      await ctx.app.inject({
        method: "PUT",
        url: `/profiles/${p.id}/rotation-link`,
        payload: { providerId: provider.id, mode: "rotate" },
      });

      const run = await lifecycle.start(p.id);
      const snap = snapshots.forRun(run.id)!;
      expect(snap.proxySource).toBe("profile");
      expect(snap.proxyId).toBe(attached.id);
      expect(snap.proxyUrl).toBe("http://127.0.0.1:8080");
      await lifecycle.stop(p.id);
    },
    { timeout: 20000 },
  );

  it(
    "drift while running explains the next launch may resolve a different proxy",
    async () => {
      const ctx = makeTestContext();
      const { lifecycle, profiles } = ctx;
      const provider = await makePool(ctx);
      const p = profiles.create({ name: "rot-drift", generateFingerprint: true });
      await ctx.app.inject({
        method: "PUT",
        url: `/profiles/${p.id}/rotation-link`,
        payload: { providerId: provider.id, mode: "rotate" },
      });

      await lifecycle.start(p.id);
      const drift = lifecycle.identityDrift(p.id);
      expect(drift).not.toBeNull();
      expect(drift!.stale).toBe(true);
      expect(drift!.fields).toEqual(["proxy"]);
      expect(drift!.message).toContain("rotation link");

      const http = await ctx.app.inject({
        method: "GET",
        url: `/profiles/${p.id}/drift`,
      });
      expect(http.json().drift.message).toContain("rotation link");
      await lifecycle.stop(p.id);
    },
    { timeout: 20000 },
  );

  it("HTTP: PUT validates the provider, GET returns the link, DELETE clears it", async () => {
    const ctx = makeTestContext();
    const { profiles, app } = ctx;
    const provider = await makePool(ctx);
    const p = profiles.create({ name: "rot-http", generateFingerprint: true });

    const unknown = await app.inject({
      method: "PUT",
      url: `/profiles/${p.id}/rotation-link`,
      payload: { providerId: "00000000-0000-0000-0000-000000000000", mode: "rotate" },
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe("PROVIDER_NOT_FOUND");

    const put = await app.inject({
      method: "PUT",
      url: `/profiles/${p.id}/rotation-link`,
      payload: { providerId: provider.id, mode: "rotate" },
    });
    expect(put.statusCode).toBe(200);

    const got = await app.inject({
      method: "GET",
      url: `/profiles/${p.id}/rotation-link`,
    });
    expect(got.json().link).toEqual({
      providerId: provider.id,
      mode: "rotate",
    });

    const del = await app.inject({
      method: "DELETE",
      url: `/profiles/${p.id}/rotation-link`,
    });
    expect(del.statusCode).toBe(200);

    const cleared = await app.inject({
      method: "GET",
      url: `/profiles/${p.id}/rotation-link`,
    });
    expect(cleared.json().link).toBeNull();
  });
});

/**
 * P-LOCK (owner, 2026-11-19): "once we create a profile, that profile sticks
 * with that IP going forward". sticky = first launch pins, later launches
 * reuse it, a vanished endpoint refuses loudly, only re-roll changes it.
 */
describe("P-LOCK sticky rotation links", () => {
  it(
    "pins the first launch's endpoint and keeps it while the pool moves on",
    async () => {
      const ctx = makeTestContext();
      const { lifecycle, profiles, snapshots } = ctx;
      const provider = await makePool(ctx);
      const a = profiles.create({ name: "locked-a", generateFingerprint: true });
      const b = profiles.create({ name: "locked-b", generateFingerprint: true });
      for (const p of [a, b]) {
        await ctx.app.inject({ method: "PUT", url: `/profiles/${p.id}/rotation-link`, payload: { providerId: provider.id, mode: "sticky" } });
      }
      const urls: string[] = [];
      for (let i = 0; i < 3; i++) {
        for (const p of [a, b]) {
          const run = await lifecycle.start(p.id);
          urls.push(`${p.name}=${snapshots.forRun(run.id)!.proxyUrl}`);
          await lifecycle.stop(p.id);
        }
      }
      expect(urls).toEqual([
        "locked-a=http://10.0.0.1:8080", "locked-b=http://10.0.0.2:8080",
        "locked-a=http://10.0.0.1:8080", "locked-b=http://10.0.0.2:8080",
        "locked-a=http://10.0.0.1:8080", "locked-b=http://10.0.0.2:8080",
      ]);
      const link = (await ctx.app.inject({ method: "GET", url: `/profiles/${a.id}/rotation-link` })).json().link;
      expect(link).toMatchObject({ mode: "sticky", pinned: { host: "10.0.0.1", port: 8080, username: null } });
    },
    { timeout: 30000 },
  );

  it(
    "survives a provider refresh (rows re-created), refuses loudly when its endpoint is gone",
    async () => {
      const ctx = makeTestContext();
      const { lifecycle, profiles, snapshots, proxyProviders } = ctx;
      const provider = await makePool(ctx);
      const p = profiles.create({ name: "locked", generateFingerprint: true });
      await ctx.app.inject({ method: "PUT", url: `/profiles/${p.id}/rotation-link`, payload: { providerId: provider.id, mode: "sticky" } });
      await lifecycle.start(p.id);
      await lifecycle.stop(p.id);

      await proxyProviders.refresh(provider.id); // same file → new row ids
      const run = await lifecycle.start(p.id);
      expect(snapshots.forRun(run.id)!.proxyUrl).toBe("http://10.0.0.1:8080");
      await lifecycle.stop(p.id);

      fs.writeFileSync(proxyProviders.get(provider.id).sourcePath!, "us-2,10.0.0.2,8080,,,\nus-3,10.0.0.3,8080,,,");
      await proxyProviders.refresh(provider.id);
      await expect(lifecycle.start(p.id)).rejects.toThrow(/locked to 10\.0\.0\.1:8080.*re-roll/);
    },
    { timeout: 30000 },
  );

  it(
    "re-roll is the only way to a new IP, and is refused while running",
    async () => {
      const ctx = makeTestContext();
      const { lifecycle, profiles, snapshots } = ctx;
      const provider = await makePool(ctx);
      const p = profiles.create({ name: "reroll", generateFingerprint: true });
      await ctx.app.inject({ method: "PUT", url: `/profiles/${p.id}/rotation-link`, payload: { providerId: provider.id, mode: "sticky" } });
      await lifecycle.start(p.id);
      const busy = await ctx.app.inject({ method: "POST", url: `/profiles/${p.id}/rotation-link/reroll` });
      expect(busy.statusCode).toBe(400);
      await lifecycle.stop(p.id);

      const ok = await ctx.app.inject({ method: "POST", url: `/profiles/${p.id}/rotation-link/reroll` });
      expect(ok.statusCode).toBe(200);
      const run = await lifecycle.start(p.id);
      expect(snapshots.forRun(run.id)!.proxyUrl).toBe("http://10.0.0.2:8080");
      await lifecycle.stop(p.id);

      const rotate = profiles.create({ name: "not-sticky", generateFingerprint: true });
      await ctx.app.inject({ method: "PUT", url: `/profiles/${rotate.id}/rotation-link`, payload: { providerId: provider.id, mode: "rotate" } });
      expect((await ctx.app.inject({ method: "POST", url: `/profiles/${rotate.id}/rotation-link/reroll` })).statusCode).toBe(400);
    },
    { timeout: 30000 },
  );
});
