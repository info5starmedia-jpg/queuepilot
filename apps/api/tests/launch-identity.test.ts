import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { makeTestContext } from "./helpers.js";
import {
  LaunchIdentityService,
  stripProxyPassword,
} from "../src/application/lifecycle/launch-identity.service.js";

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

describe("snapshot proxy passwords (secrets at rest)", () => {
  it("stripProxyPassword drops only the password", () => {
    expect(stripProxyPassword(null)).toBeNull();
    expect(stripProxyPassword("http://alice:s3cret@10.0.0.1:8080")).toBe("http://alice@10.0.0.1:8080");
    expect(stripProxyPassword("socks5://u:p%40ss%2Fw@h:1080")).toBe("socks5://u@h:1080");
    // Credential-free and username-only URLs are returned byte-identical.
    expect(stripProxyPassword("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
    expect(stripProxyPassword("http://alice@10.0.0.1:8080")).toBe("http://alice@10.0.0.1:8080");
    expect(stripProxyPassword("garbage:pw@@")).not.toContain("pw");
  });

  it("boot migration rewrites old snapshots without the password, once", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "queuepilot-snapmig-"));
    const dir = path.join(dataDir, "snapshots");
    fs.mkdirSync(dir, { recursive: true });
    const base = {
      id: "11111111-1111-4111-8111-111111111111",
      runId: "22222222-2222-4222-8222-222222222222",
      profileId: "33333333-3333-4333-8333-333333333333",
      engineKind: "fury",
      identityId: null,
      identity: null,
      proxyId: null,
      proxySource: "profile",
      egress: {
        relayPort: 41000,
        exitIp: "203.0.113.7",
        webrtcPublicIp: "203.0.113.7",
        webrtcHostName: null,
        checkedAt: "2026-11-01T00:00:00.000Z",
      },
      capturedAt: "2026-11-01T00:00:00.000Z",
    };
    const secretFile = path.join(dir, `${base.runId}.json`);
    fs.writeFileSync(secretFile, JSON.stringify({ ...base, proxyUrl: "http://bob:hunter2@10.0.0.5:3128" }));
    const cleanRunId = "44444444-4444-4444-8444-444444444444";
    const cleanFile = path.join(dir, `${cleanRunId}.json`);
    const cleanBody = JSON.stringify({ ...base, runId: cleanRunId, proxyUrl: "http://10.0.0.6:3128" });
    fs.writeFileSync(cleanFile, cleanBody);
    fs.writeFileSync(path.join(dir, "broken.json"), "{ not json");

    const svc = new LaunchIdentityService(dataDir);
    expect(svc.stripStoredProxyPasswords()).toEqual({ rewritten: 1, skipped: 1 });
    expect(fs.readFileSync(secretFile, "utf8")).not.toContain("hunter2");
    const migrated = svc.forRun(base.runId)!;
    expect(migrated.proxyUrl).toBe("http://bob@10.0.0.5:3128");
    // Everything else — notably the relay port the adopted-relay guard reads — survives.
    expect(migrated.egress?.relayPort).toBe(41000);
    expect(migrated.proxySource).toBe("profile");
    // Files with nothing to strip are untouched.
    expect(fs.readFileSync(cleanFile, "utf8")).toBe(cleanBody);
    // Idempotent: a second boot rewrites nothing.
    expect(svc.stripStoredProxyPasswords()).toEqual({ rewritten: 0, skipped: 1 });
    // No temp files left behind by the atomic writes.
    expect(fs.readdirSync(dir).filter((n) => n.includes(".tmp-"))).toEqual([]);
  });

  it("egress diagnostics still identify a proxied run from a stripped snapshot", async () => {
    const { app, lifecycle, profiles, proxies, dataDir } = makeTestContext();
    const proxy = proxies.create({
      name: "auth",
      type: "http",
      host: "10.0.0.7",
      port: 8080,
      username: "carol",
      password: "pa55word",
    });
    const p = profiles.create({ name: "egress-strip", proxyId: proxy.id, generateFingerprint: true });
    const run = await lifecycle.start(p.id);
    const onDisk = fs.readFileSync(path.join(dataDir, "snapshots", `${run.id}.json`), "utf8");
    expect(onDisk).not.toContain("pa55word");
    const res = await app.inject({ method: "GET", url: `/profiles/${p.id}/egress` });
    expect(res.json()).toMatchObject({
      running: true,
      proxyUrl: "http://***@10.0.0.7:8080/",
      proxySource: "profile",
    });
    // Drift still compares pointers, not the URL.
    expect(lifecycle.identityDrift(p.id)!.stale).toBe(false);
    await lifecycle.stop(p.id);
  });
});
