import { describe, expect, it } from "vitest";
import { makeTestContext } from "./helpers.js";

const TEMP = {
  type: "socks5",
  host: "10.0.0.9",
  port: 1080,
  username: "u",
  password: "secret",
} as const;

/**
 * Temporary proxies (Jancy-style): a one-shot proxy passed at launch that
 * applies to exactly one run and dies with it. The profile row is never
 * mutated; the launch snapshot records provenance so drift can explain it.
 */
describe("temporary proxies", () => {
  it("launches with the temp proxy, snapshots provenance, never touches the profile row", async () => {
    const { lifecycle, profiles, proxies, snapshots } = makeTestContext();
    const stored = proxies.create({
      name: "attached",
      type: "http",
      host: "127.0.0.1",
      port: 8080,
    });
    const p = profiles.create({
      name: "tp",
      proxyId: stored.id,
      generateFingerprint: true,
    });

    const run = await lifecycle.start(p.id, { tempProxy: { ...TEMP } });

    const snap = snapshots.forRun(run.id);
    expect(snap).not.toBeNull();
    expect(snap!.proxySource).toBe("temporary");
    expect(snap!.proxyId).toBeNull();
    expect(snap!.proxyUrl).toBe("socks5://u:secret@10.0.0.9:1080");

    // The profile still points at its own attached proxy.
    expect(profiles.get(p.id).proxyId).toBe(stored.id);

    await lifecycle.stop(p.id);
  });

  it("drift explains that a temporary proxy is in use while running", async () => {
    const { lifecycle, profiles } = makeTestContext();
    const p = profiles.create({ name: "tp-drift", generateFingerprint: true });

    await lifecycle.start(p.id, { tempProxy: { ...TEMP } });
    const drift = lifecycle.identityDrift(p.id);

    expect(drift).not.toBeNull();
    expect(drift!.stale).toBe(true);
    expect(drift!.fields).toEqual(["proxy"]);
    expect(drift!.message).toContain("temporary proxy");

    await lifecycle.stop(p.id);
  });

  it("the profile's own proxy applies again at the next start", async () => {
    const { lifecycle, profiles, proxies, snapshots } = makeTestContext();
    const stored = proxies.create({
      name: "attached",
      type: "http",
      host: "127.0.0.1",
      port: 8080,
    });
    const p = profiles.create({
      name: "tp-next",
      proxyId: stored.id,
      generateFingerprint: true,
    });

    const tempRun = await lifecycle.start(p.id, { tempProxy: { ...TEMP } });
    expect(snapshots.forRun(tempRun.id)!.proxySource).toBe("temporary");
    await lifecycle.stop(p.id);

    const nextRun = await lifecycle.start(p.id);
    const snap = snapshots.forRun(nextRun.id)!;
    expect(snap.proxySource).toBe("profile");
    expect(snap.proxyId).toBe(stored.id);
    expect(snap.proxyUrl).toBe("http://127.0.0.1:8080");
    // No drift: the running identity matches the profile again.
    expect(lifecycle.identityDrift(p.id)!.stale).toBe(false);

    await lifecycle.stop(p.id);
  });

  it("a temp proxy on a profile with no attached proxy snapshots proxySource=temporary", async () => {
    const { lifecycle, profiles, snapshots } = makeTestContext();
    const p = profiles.create({ name: "tp-none", generateFingerprint: true });

    const run = await lifecycle.start(p.id, {
      tempProxy: { type: "http", host: "192.0.2.1", port: 3128 },
    });
    const snap = snapshots.forRun(run.id)!;
    expect(snap.proxySource).toBe("temporary");
    expect(snap.proxyUrl).toBe("http://192.0.2.1:3128");

    await lifecycle.stop(p.id);
  });

  it("HTTP: POST /profiles/:id/start accepts a tempProxy and serves it over the API", async () => {
    const { app, profiles, lifecycle, snapshots } = makeTestContext();
    const p = profiles.create({ name: "tp-http", generateFingerprint: true });

    const res = await app.inject({
      method: "POST",
      url: `/profiles/${p.id}/start`,
      payload: { tempProxy: { ...TEMP } },
    });
    expect(res.statusCode).toBe(201);
    const run = res.json();
    expect(snapshots.forRun(run.id)!.proxySource).toBe("temporary");

    const drift = await app.inject({
      method: "GET",
      url: `/profiles/${p.id}/drift`,
    });
    expect(drift.json().drift.message).toContain("temporary proxy");

    await lifecycle.stop(p.id);
  });

  it("HTTP: an invalid tempProxy is rejected with VALIDATION_FAILED and nothing launches", async () => {
    const { app, profiles, lifecycle } = makeTestContext();
    const p = profiles.create({ name: "tp-bad", generateFingerprint: true });

    const badPort = await app.inject({
      method: "POST",
      url: `/profiles/${p.id}/start`,
      payload: { tempProxy: { type: "http", host: "127.0.0.1", port: 70000 } },
    });
    expect(badPort.statusCode).toBe(400);
    expect(badPort.json().error.code).toBe("VALIDATION_FAILED");

    const unknownKey = await app.inject({
      method: "POST",
      url: `/profiles/${p.id}/start`,
      payload: { tempProxy: { ...TEMP }, surprise: true },
    });
    expect(unknownKey.statusCode).toBe(400);

    expect(lifecycle.activeRun(p.id)).toBeNull();
  });
});
