import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runRemoteCli, parseRemoteFlags } from "../src/cli/remote.js";
import { compareVersions, runEngineUpdate } from "../src/cli/engine-update.js";
import { makeTestContext } from "./helpers.js";

describe("parseRemoteFlags", () => {
  it("parses flags and positionals", () => {
    expect(parseRemoteFlags(["profiles", "list", "--json", "--group", "g1"])).toMatchObject({
      _: ["profiles", "list"],
      json: true,
      group: "g1",
    });
    expect(parseRemoteFlags(["profiles", "import", "f.csv", "--dry-run", "--no-upsert"])).toMatchObject({
      dryRun: true,
      upsert: false,
    });
  });
});

describe("remote CLI against a live server", () => {
  async function live() {
    const { app, profiles } = makeTestContext();
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const out: string[] = [];
    const deps = {
      baseUrl: address,
      log: (m: string) => out.push(m),
      err: (m: string) => out.push(`ERR ${m}`),
    };
    return { app, profiles, out, deps };
  }

  it("profiles list --json round-trips", async () => {
    const { app, profiles, out, deps } = await live();
    profiles.create({ name: "cli-one", generateFingerprint: true });
    const code = await runRemoteCli(["profiles", "list", "--json"], deps);
    expect(code).toBe(0);
    const data = JSON.parse(out[0]!);
    expect(data.profiles.map((p: { name: string }) => p.name)).toContain("cli-one");
    await app.close();
  });

  it("profiles import runs through the HTTP surface", async () => {
    const { app, out, deps } = await live();
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "qp-cli-")), "p.csv");
    fs.writeFileSync(file, "name,proxy\ncli-import,,");
    const code = await runRemoteCli(["profiles", "import", file], deps);
    expect(code).toBe(0);
    expect(out.join("\n")).toMatch(/1\/1 rows ok/);
    await app.close();
  });

  it("profile start/stop by name", async () => {
    const { app, profiles, out, deps } = await live();
    profiles.create({ name: "cli-run", generateFingerprint: true });
    const c0 = await runRemoteCli(["profile", "start", "cli-run"], deps);
    if (c0 !== 0) throw new Error(`start failed: ${JSON.stringify(out)}`);
    expect(c0).toBe(0);
    expect(await runRemoteCli(["profile", "run", "cli-run", "--json"], deps)).toBe(0);
    expect(await runRemoteCli(["profile", "stop", "cli-run"], deps)).toBe(0);
    await app.close();
  });

  it("unknown profile name exits 2", async () => {
    const { app, deps } = await live();
    expect(await runRemoteCli(["profile", "start", "ghost"], deps)).toBe(2);
    await app.close();
  });
});

describe("compareVersions", () => {
  it("orders base and -qp.N prereleases", () => {
    expect(compareVersions("157.0.0", "157.0.0-qp.1")).toBeLessThan(0);
    expect(compareVersions("157.0.0-qp.2", "157.0.0-qp.10")).toBeLessThan(0);
    expect(compareVersions("158.0.0", "157.9.9-qp.99")).toBeGreaterThan(0);
  });
});

describe("engine update", () => {
  function manifest(version: string) {
    return JSON.stringify({
      schemaVersion: 1,
      engines: [
        {
          kind: "fury-core",
          version,
          platform: "windows-x64",
          url: "https://example.invalid/engine.tar.gz",
          sha256: "0".repeat(64),
          sizeBytes: 123,
        },
      ],
    });
  }

  it("refuses to download without --yes", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qp-eng-"));
    const mfile = path.join(dir, "m.json");
    fs.writeFileSync(mfile, manifest("157.0.0-qp.1"));
    const out: string[] = [];
    const code = await runEngineUpdate(["--manifest", mfile], {
      enginesDir: dir,
      log: (m) => out.push(m),
    });
    expect(code).toBe(1);
    expect(out.join("\n")).toMatch(/update available/);
    expect(out.join("\n")).toMatch(/Nothing was downloaded/);
  });

  it("bad manifest path exits 2", async () => {
    const code = await runEngineUpdate(["--manifest", "C:\\no\\such\\file.json"], {
      enginesDir: os.tmpdir(),
      log: () => {},
    });
    expect(code).toBe(2);
  });
});
