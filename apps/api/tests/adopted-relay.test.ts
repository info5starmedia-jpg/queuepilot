import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { captureProcessStartToken } from "../src/infrastructure/process-inventory.js";
import { holdRelayPort } from "../src/application/runtime/proxy-relay.js";
import { makeTestContext, type TestContext } from "./helpers.js";

/**
 * After an API restart an adopted fury engine still points
 * `--proxy-server` at its old relay port, which died with the old API.
 * Verified live: the engine fails closed while the port is empty, but
 * whatever binds that port next receives the profile's traffic. The API now
 * holds that port closed for every adopted proxied run.
 */

const children: ChildProcess[] = [];
const contexts: TestContext[] = [];
const servers: net.Server[] = [];

afterEach(async () => {
  for (const ctx of contexts.splice(0)) {
    ctx.lifecycle.stopAdoptedWatcher();
    for (const id of [...ctx.lifecycle["relayHolds"].keys()]) ctx.lifecycle["releaseRelayHold"](id);
  }
  for (const c of children.splice(0)) c.kill();
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

function spawnSleeper(): ChildProcess {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  children.push(child);
  return child;
}

/** A free loopback port (bind :0, release). */
async function freePort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as net.AddressInfo).port;
  await new Promise((r) => srv.close(r));
  return port;
}

/** What a client (the engine) gets when it talks to 127.0.0.1:port. */
function probe(port: number): Promise<string> {
  return new Promise((resolve) => {
    const sock = net.connect(port, "127.0.0.1");
    let data = "";
    sock.on("data", (d) => (data += d.toString("latin1")));
    sock.on("connect", () => sock.write("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n"));
    sock.on("close", () => resolve(data));
    sock.on("error", (e) => resolve(`error:${(e as NodeJS.ErrnoException).code}`));
  });
}

/**
 * An adopted run (API restarted, engine kept running) whose launch snapshot
 * says it went through a proxy relay on `relayPort`.
 */
async function adoptedProxiedRun(ctx: TestContext, relayPort: number) {
  const child = spawnSleeper();
  const p = ctx.profiles.create({ name: `relay-${relayPort}`, generateFingerprint: true });
  const started = await ctx.lifecycle.start(p.id);
  const run = { ...started, pid: child.pid!, processToken: captureProcessStartToken(child.pid!) };
  ctx.lifecycle["runs"].update(run);
  ctx.lifecycle["sessions"].clear();
  const file = path.join(ctx.dataDir, "snapshots", `${run.id}.json`);
  const snap = JSON.parse(fs.readFileSync(file, "utf8"));
  snap.proxyUrl = "http://user:pass@127.0.0.1:9";
  snap.proxySource = "profile";
  snap.egress = {
    relayPort,
    exitIp: "203.0.113.7",
    webrtcPublicIp: "203.0.113.7",
    webrtcHostName: null,
    checkedAt: new Date().toISOString(),
  };
  fs.writeFileSync(file, JSON.stringify(snap));
  return { profileId: p.id, run, child };
}

function context(): TestContext {
  const ctx = makeTestContext();
  ctx.lifecycle["adoptedStopGraceMs"] = 1_500;
  contexts.push(ctx);
  return ctx;
}

describe("holdRelayPort", () => {
  it("answers every connection with 502 and keeps the port from anyone else", async () => {
    const port = await freePort();
    const hold = await holdRelayPort(port);
    expect(hold).not.toBeNull();
    expect(await probe(port)).toMatch(/^HTTP\/1\.1 502 /);
    expect(hold!.refused()).toBe(1);
    // A squatter cannot bind it while it is held.
    const squatter = net.createServer();
    const err = await new Promise<string | null>((r) => {
      squatter.once("error", (e) => r((e as NodeJS.ErrnoException).code ?? "error"));
      squatter.listen(port, "127.0.0.1", () => r(null));
    });
    if (err === null) servers.push(squatter);
    expect(err).toBe("EADDRINUSE");
    await hold!.close();
    expect(await probe(port)).toMatch(/^error:ECONNREFUSED/);
  });

  it("returns null when the port is already taken", async () => {
    const taken = net.createServer();
    await new Promise<void>((r) => taken.listen(0, "127.0.0.1", r));
    servers.push(taken);
    expect(await holdRelayPort((taken.address() as net.AddressInfo).port)).toBeNull();
  });
});

describe("adopted proxied runs after an API restart", () => {
  it("holds the dead relay port, and egress stops claiming the launch exit IP is live", async () => {
    const ctx = context();
    const port = await freePort();
    const { profileId } = await adoptedProxiedRun(ctx, port);
    ctx.lifecycle.reconcileOnBoot();

    expect(await ctx.lifecycle.guardAdoptedRelays()).toEqual({ held: 1, unguarded: 0 });
    expect(await probe(port)).toMatch(/^HTTP\/1\.1 502 /);

    const egress = ctx.lifecycle.egressDiagnostics(profileId)!;
    expect(egress.relay).toBe("lost-held");
    expect(egress.note).toMatch(/fails \(nothing leaks\)/);
    expect(egress.proxyUrl).not.toContain("pass"); // still credential-redacted
    const metrics = (await ctx.app.inject({ method: "GET", url: "/metrics" })).json();
    expect(metrics).toMatchObject({ relaysHeld: 1, relaysUnguarded: 0 });
  });

  it("reports an unguarded relay loudly when another process already owns the port", async () => {
    const ctx = context();
    const squatter = net.createServer((s) => s.end());
    await new Promise<void>((r) => squatter.listen(0, "127.0.0.1", r));
    servers.push(squatter);
    const port = (squatter.address() as net.AddressInfo).port;
    const { profileId } = await adoptedProxiedRun(ctx, port);
    ctx.lifecycle.reconcileOnBoot();

    expect(await ctx.lifecycle.guardAdoptedRelays()).toEqual({ held: 0, unguarded: 1 });
    const egress = ctx.lifecycle.egressDiagnostics(profileId)!;
    expect(egress.relay).toBe("lost-unguarded");
    expect(egress.note).toMatch(/owned by another process/);
  });

  it("releases the port when the adopted run is stopped", async () => {
    const ctx = context();
    const port = await freePort();
    const { profileId } = await adoptedProxiedRun(ctx, port);
    ctx.lifecycle.reconcileOnBoot();
    await ctx.lifecycle.guardAdoptedRelays();

    await ctx.lifecycle.stop(profileId); // token-proven: the sleeper is killed

    expect(ctx.lifecycle["relayHolds"].size).toBe(0);
    expect(await probe(port)).toMatch(/^error:ECONNREFUSED/);
  });

  it("releases the port when the watcher finds the adopted engine dead", async () => {
    const ctx = context();
    const port = await freePort();
    const { child } = await adoptedProxiedRun(ctx, port);
    ctx.lifecycle.reconcileOnBoot();
    ctx.lifecycle.stopAdoptedWatcher();
    await ctx.lifecycle.guardAdoptedRelays();

    const gone = new Promise((r) => child.once("exit", r));
    child.kill();
    await gone;
    expect(ctx.lifecycle.checkAdoptedRuns(false)).toBe(1);

    expect(ctx.lifecycle["relayHolds"].size).toBe(0);
    expect(await probe(port)).toMatch(/^error:ECONNREFUSED/);
  });

  it("leaves runs alone that have no proxy or a live session", async () => {
    const ctx = context();
    const p = ctx.profiles.create({ name: "direct", generateFingerprint: true });
    await ctx.lifecycle.start(p.id); // live session, no proxy in its snapshot
    expect(await ctx.lifecycle.guardAdoptedRelays()).toEqual({ held: 0, unguarded: 0 });
    expect(ctx.lifecycle.egressDiagnostics(p.id)!.relay).toBeNull();
  });
});
