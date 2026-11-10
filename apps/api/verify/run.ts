import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { FingerprintIdentity, Profile } from "@queuepilot/contracts";
import { CamoufoxRuntime, defaultCamoufoxPath } from "../src/application/runtime/camoufox.runtime.js";
import { FuryCoreRuntime, resolveFuryBinary } from "../src/application/runtime/fury-core.runtime.js";
import type { BrowserRuntime, BrowserSession } from "../src/application/runtime/browser-runtime.js";
import { generateIdentity } from "../src/application/profiles/fingerprint-generator.js";
import { withPage } from "../src/application/runtime/cdp/cdp-page.js";
import { CLAIMS, expectationClaims, type ClaimResult, type PersonaExpectation } from "./claims.js";

/**
 * Detection claim runner — the P4 "detection CI" surface.
 *
 *   npx tsx verify/run.ts --engine fury
 *   npx tsx verify/run.ts --engine camoufox
 *
 * Launches the REAL engine the way the product launches it (same runtime
 * classes, same persona plumbing), generates a fresh identity, then states
 * claims about what the engine reports. One line per claim; exit 1 if any
 * claim is false. External checkers (CreepJS et al.) stay manual — a CI gate
 * must never depend on a third-party site's mood.
 */
interface RunArgs {
  engine: string;
  dataDir: string;
}

function parseArgs(argv: string[]): RunArgs {
  const args: RunArgs = {
    engine: "fury",
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "queuepilot-verify-")),
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

function expectationFor(identity: FingerprintIdentity): PersonaExpectation {
  return {
    userAgentContainsChrome: true,
    platform:
      identity.platform === "windows"
        ? "Win32"
        : identity.platform === "macos"
          ? "MacIntel"
          : "Linux x86_64",
    hardwareConcurrency: identity.hardwareConcurrency,
    // Chromium's navigator.deviceMemory is absent in some contexts — observed
    // null is not a mismatch (same rule as attestation), so don't bind it.
    screenWidth: identity.screenWidth,
    screenHeight: identity.screenHeight,
    timezone: identity.timezone,
    locale: identity.locale,
  };
}

async function discoverWsEndpoint(debugPort: number, fallback: string): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const res = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
      if (res.ok) {
        const info = (await res.json()) as { webSocketDebuggerUrl?: string };
        if (info.webSocketDebuggerUrl) return info.webSocketDebuggerUrl;
      }
    } catch {
      // debug port not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return fallback;
}

/**
 * The probe page must be an ordinary HTTP-served web page: DevTools' own
 * pages (/json/version) suppress window.chrome, and about:blank hides
 * userAgentData and deviceMemory. A throwaway loopback server gives us a
 * real, secure, ordinary origin with zero external dependency.
 */
async function serveProbePage(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><html><head><title>probe</title></head><body>probe</body></html>");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("probe server has no address");
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

export async function runVerification(
  argv: string[],
  log: (m: string) => void = (m) => console.log(m),
): Promise<number> {
  const args = parseArgs(argv);
  const runtime = runtimeFor(args.engine, args.dataDir);
  const identity = generateIdentity("windows");
  const profile: Profile = {
    id: "00000000-0000-4000-8000-000000000000",
    name: "verify-probe",
    group: "verify",
    proxyId: null,
    identityId: identity.id,
    status: "idle",
    notes: "",
    tags: [],
    email: null,
    providerId: null,
    providerKey: null,
    extra: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  log(`verify: engine=${runtime.kind} dataDir=${args.dataDir}`);
  let session: BrowserSession | null = null;
  const probe = await serveProbePage();
  try {
    session = await runtime.launch({
      profile,
      identity,
      proxyUrl: null,
      profileDataDir: path.join(args.dataDir, "verify-profile"),
    });
    const ws = await discoverWsEndpoint(session.debugPort, session.wsEndpoint);
    const pageUrl = probe.url;

    const claims = [...CLAIMS, ...expectationClaims(expectationFor(identity))];
    const results: ClaimResult[] = await withPage(ws, pageUrl, async (page) => {
      const out: ClaimResult[] = [];
      for (const claim of claims) {
        try {
          out.push(await claim.check(page));
        } catch (err) {
          out.push({
            id: claim.id,
            pass: false,
            detail: `PROBE-ERROR: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
          });
        }
      }
      return out;
    });

    let failed = 0;
    for (const r of results) {
      if (!r.pass) failed++;
      log(`${r.pass ? "PASS" : "FAIL"} ${r.id} — ${r.detail}`);
    }
    log(`verify: ${results.length - failed}/${results.length} claims hold on ${runtime.kind}`);
    return failed === 0 ? 0 : 1;
  } catch (err) {
    log(`verify: launch/harness failed: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  } finally {
    if (session) await session.stop().catch(() => {});
    await probe.close().catch(() => {});
  }
}

// CLI entry: tsx verify/run.ts --engine fury
if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, "/")}`).href) {
  runVerification(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(2);
    },
  );
}
