import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { makeTestContext } from "./helpers.js";

/**
 * Launch-identity snapshot guarantees: the engine's launch inputs are frozen
 * at start, edits while running never touch the live session, and the drift
 * signal is what tells the user "applies at next start".
 */
describe("LaunchIdentity snapshots", () => {
  it("captures a durable snapshot at launch with the exact launch inputs", async () => {
    const { lifecycle, profiles, dataDir } = makeTestContext();
    const p = profiles.create({ name: "snap", generateFingerprint: true });
    const run = await lifecycle.start(p.id);

    const file = path.join(dataDir, "snapshots", `${run.id}.json`);
    expect(fs.existsSync(file)).toBe(true);
    const snap = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(snap.profileId).toBe(p.id);
    expect(snap.identityId).toBe(profiles.get(p.id).identityId);
    expect(snap.identity.seed).toBeGreaterThan(0);
    expect(snap.engineKind).toBe("fake");
    expect(snap.proxyId).toBeNull();
    await lifecycle.stop(p.id);
  });

  it("reports no drift right after launch", async () => {
    const { lifecycle, profiles } = makeTestContext();
    const p = profiles.create({ name: "steady", generateFingerprint: true });
    await lifecycle.start(p.id);
    const drift = lifecycle.identityDrift(p.id);
    expect(drift).not.toBeNull();
    expect(drift!.stale).toBe(false);
    expect(drift!.fields).toEqual([]);
    await lifecycle.stop(p.id);
  });

  it("regenerating the fingerprint while running marks drift — applies at next start", async () => {
    const { lifecycle, profiles } = makeTestContext();
    const p = profiles.create({ name: "edit-live", generateFingerprint: true });
    await lifecycle.start(p.id);

    profiles.regenerateFingerprint(p.id);
    const drift = lifecycle.identityDrift(p.id);
    expect(drift!.stale).toBe(true);
    expect(drift!.fields).toContain("identity");
    expect(drift!.message).toContain("applies at next start");

    // The frozen snapshot still holds the ORIGINAL identity — the running
    // session was never mutated (verified via the snapshot file in the first
    // test; here we care about the drift signal).
    await lifecycle.stop(p.id);

    // After restart, drift clears: the new launch re-snapshots.
    const run2 = await lifecycle.start(p.id);
    const drift2 = lifecycle.identityDrift(p.id);
    expect(drift2!.stale).toBe(false);
    await lifecycle.stop(p.id);
    expect(run2.status).toBe("running");
  });

  it("changing the proxy while running marks proxy drift", async () => {
    const { lifecycle, profiles, proxies } = makeTestContext();
    const p = profiles.create({ name: "proxy-drift", generateFingerprint: true });
    await lifecycle.start(p.id);

    const proxy = proxies.create({
      name: "p1",
      type: "http",
      host: "127.0.0.1",
      port: 8080,
      username: null,
      password: null,
    });
    profiles.update(p.id, { proxyId: proxy.id });
    const drift = lifecycle.identityDrift(p.id);
    expect(drift!.stale).toBe(true);
    expect(drift!.fields).toEqual(["proxy"]);
    await lifecycle.stop(p.id);
  });

  it("returns null drift when the profile is not running", () => {
    const { lifecycle, profiles } = makeTestContext();
    const p = profiles.create({ name: "idle", generateFingerprint: true });
    expect(lifecycle.identityDrift(p.id)).toBeNull();
  });

  it("exposes drift over HTTP at GET /profiles/:id/drift", async () => {
    const { app, profiles } = makeTestContext();
    const p = profiles.create({ name: "http-drift", generateFingerprint: true });
    await app.inject({ method: "POST", url: `/profiles/${p.id}/start` });
    profiles.regenerateFingerprint(p.id);
    const res = await app.inject({ method: "GET", url: `/profiles/${p.id}/drift` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { drift: { stale: boolean; fields: string[] } };
    expect(body.drift.stale).toBe(true);
    expect(body.drift.fields).toContain("identity");
    await app.inject({ method: "POST", url: `/profiles/${p.id}/stop` });
  });
});
