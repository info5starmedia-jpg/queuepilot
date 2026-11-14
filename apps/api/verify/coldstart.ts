import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { Profile } from "@queuepilot/contracts";
import { FuryCoreRuntime, resolveFuryBinary } from "../src/application/runtime/fury-core.runtime.js";
import { CamoufoxRuntime, defaultCamoufoxPath } from "../src/application/runtime/camoufox.runtime.js";
import type { BrowserRuntime } from "../src/application/runtime/browser-runtime.js";
import { generateIdentity } from "../src/application/profiles/fingerprint-generator.js";
import { cleanProfileDirStaleness } from "../src/application/runtime/profile-hygiene.js";

/**
 * P5.6 measurement — cold start + hard-kill hygiene, run against the REAL
 * engine exactly the way the product launches it.
 *
 *   npx tsx verify/coldstart.ts --engine fury
 *
 * Claims:
 *  - cold-start: launch() called → probe page actually fetched, under 2.5s.
 *  - hygiene: after a HARD kill, the next launch still succeeds (the
 *    pre-launch cleaner removed Chromium's singleton residue).
 */

const COLD_START_BUDGET_MS = 2500;

interface Args {
  engine: string;
  dataDir: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    engine: "fury",
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "queuepilot-coldstart-")),
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--engine") args.engine = argv[++i] ?? "fury";
    else if (argv[i] === "--data-dir") args.dataDir = argv[++i] ?? args.dataDir;
  }
  return args;
}

function runtimeFor(engine: string, dataDir: string): BrowserRuntime {
  if (engine === "fury") return new FuryCoreRuntime(resolveFuryBinary(dataDir));
  if (engine === "camoufox") return new CamoufoxRuntime(defaultCamoufoxPath(dataDir));
  throw new Error(`unknown engine "${engine}" (expected fury|camoufox)`);
}

/** Probe page that records the exact moment the engine fetched it. */
function serveProbe(hitAt: { current: number | null }): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    if (hitAt.current === null) hitAt.current = Date.now();
    res.writeHead(200, { "content-type": "text/html", "connection": "close" });
    res.end("<!doctype html><title>coldstart</title>coldstart");
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        url: `http://127.0.0.1:${port}/`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

export async function runColdstart(
  argv: string[],
  log: (m: string) => void = (m) => console.log(m),
): Promise<number> {
  const args = parseArgs(argv);
  const runtime = runtimeFor(args.engine, args.dataDir);
  const identity = generateIdentity("windows");
  const hitAt: { current: number | null } = { current: null };
  const probe = await serveProbe(hitAt);
  const profileDataDir = path.join(args.dataDir, "coldstart-profile");
  const profile: Profile = {
    id: "00000000-0000-4000-8000-000000000000",
    name: "coldstart-probe",
    group: "verify",
    proxyId: null,
    identityId: identity.id,
    status: "idle",
    notes: "",
    tags: [],
    email: null,
    providerId: null,
    providerKey: null,
    extra: { url: probe.url },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  let failed = 0;
  const results: { id: string; pass: boolean; detail: string }[] = [];
  try {
    // --- Claim 1: cold start ------------------------------------------------
    const t0 = Date.now();
    const session = await runtime.launch({ profile, identity, proxyUrl: null, profileDataDir });
    // The probe page is the profile's start URL; the hit timestamp is our
    // "first page" moment. Poll up to 15s for slow machines.
    for (let i = 0; i < 150 && hitAt.current === null; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const firstPageMs = hitAt.current !== null ? hitAt.current - t0 : null;
    results.push({
      id: "cold-start",
      pass: firstPageMs !== null && firstPageMs <= COLD_START_BUDGET_MS,
      detail:
        firstPageMs === null
          ? "probe page never fetched within 15s"
          : `launch → first page fetch: ${firstPageMs}ms (budget ${COLD_START_BUDGET_MS}ms, engine pid ${session.pid})`,
    });

    // --- Claim 2: hard-kill hygiene ----------------------------------------
    // Simulate the worst case: taskkill /F. Chromium cannot clean up its
    // singleton files on /F — they must be there to prove the scenario.
    process.kill(session.pid, "SIGKILL");
    await session.exited;
    await new Promise((r) => setTimeout(r, 500)); // let the OS settle handles
    const residue = [
      "DevToolsActivePort",
      "SingletonLock",
      "SingletonSocket",
      "SingletonCookie",
    ].filter((n) => fs.existsSync(path.join(profileDataDir, n)));
    log(`hygiene: hard kill left ${residue.length} residue file(s): ${residue.join(", ") || "none"}`);

    const before = cleanProfileDirStaleness(profileDataDir);
    const t1 = Date.now();
    let relaunchOk = false;
    let relaunchErr = "";
    try {
      const second = await runtime.launch({ profile, identity, proxyUrl: null, profileDataDir });
      relaunchOk = true;
      process.kill(second.pid, "SIGKILL");
      await second.exited;
    } catch (err) {
      relaunchErr = err instanceof Error ? err.message.split("\n")[0]! : String(err);
    }
    const relaunchMs = Date.now() - t1;
    results.push({
      id: "hygiene-relaunch-after-hard-kill",
      pass: relaunchOk,
      detail: relaunchOk
        ? `cleaned [${before.removed.join(", ") || "nothing"}]; relaunch succeeded in ${relaunchMs}ms`
        : `relaunch after hard kill FAILED: ${relaunchErr}`,
    });

    for (const r of results) {
      if (!r.pass) failed++;
      log(`${r.pass ? "PASS" : "FAIL"} ${r.id} — ${r.detail}`);
    }
    log(
      `coldstart: ${results.length - failed}/${results.length} claims hold on ${runtime.kind}`,
    );
    return failed === 0 ? 0 : 1;
  } catch (err) {
    log(`coldstart: harness failed: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  } finally {
    await probe.close().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, "/")}`).href) {
  runColdstart(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(2);
    },
  );
}
