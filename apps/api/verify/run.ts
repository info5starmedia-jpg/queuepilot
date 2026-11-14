import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { FingerprintIdentity, Profile } from "@queuepilot/contracts";
import { CamoufoxRuntime, defaultCamoufoxPath } from "../src/application/runtime/camoufox.runtime.js";
import { FuryCoreRuntime, resolveFuryBinary } from "../src/application/runtime/fury-core.runtime.js";
import type { BrowserRuntime, BrowserSession } from "../src/application/runtime/browser-runtime.js";
import { generateIdentity } from "../src/application/profiles/fingerprint-generator.js";
import { withPage } from "../src/application/runtime/cdp/cdp-page.js";
import { egressIpViaRelay } from "../src/application/runtime/egress-check.js";
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
  /** "upstream" = run the egress-via-proxy proof against a recording fake upstream. */
  proxy: boolean;
  /** Same proof, but the upstream is a recording SOCKS5 server (RFC 1928/1929). */
  socks5: boolean;
}

function parseArgs(argv: string[]): RunArgs {
  const args: RunArgs = {
    engine: "fury",
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "queuepilot-verify-")),
    proxy: false,
    socks5: false,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--engine") args.engine = argv[++i] ?? "fury";
    else if (argv[i] === "--data-dir") args.dataDir = argv[++i] ?? args.dataDir;
    else if (argv[i] === "--proxy") args.proxy = true;
    else if (argv[i] === "--socks5") args.socks5 = true;
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
 * userAgentData and deviceMemory. A throwaway local server gives us a real,
 * secure, ordinary origin with zero external dependency.
 *
 * With --proxy, the page is served on the LAN IP instead of loopback:
 * Chromium bypasses proxies for localhost by design, so a loopback probe
 * would prove nothing about egress.
 */
async function serveProbePage(host: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><html><head><title>probe</title></head><body>probe</body></html>");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("probe server has no address");
  return {
    url: `http://${host}:${address.port}/`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function lanIPv4(): string {
  for (const infos of Object.values(os.networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family === "IPv4" && !info.internal) return info.address;
    }
  }
  throw new Error("no non-internal IPv4 interface — cannot run the egress proof");
}

/**
 * Recording forward proxy for the egress-via-proxy proof. Demands a fixed
 * credential; records every Proxy-Authorization it sees and how many probe
 * requests transited. If the engine's traffic reaches the probe page through
 * here with the injected credential, the relay chain is proven end-to-end.
 */
const EGRESS_AUTH = `Basic ${Buffer.from("verify:pr0be").toString("base64")}`;

async function startRecordingUpstream(): Promise<{
  port: number;
  proxyUrl: string;
  sawProbeRequest: () => number;
  authAlwaysCorrect: () => boolean;
  close: () => Promise<void>;
}> {
  let probeRequests = 0;
  const auths: (string | null)[] = [];
  const server = http.createServer((req, res) => {
    auths.push(req.headers["proxy-authorization"] ?? null);
    if (req.headers["proxy-authorization"] !== EGRESS_AUTH) {
      res.writeHead(407, { "proxy-authenticate": "Basic realm=verify" });
      res.end("auth required");
      return;
    }
    probeRequests++;
    const url = new URL(req.url ?? "/");
    const fwd = http.request(
      { host: url.hostname, port: url.port, path: url.pathname, method: req.method },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    fwd.on("error", () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(fwd);
  });
  server.on("connect", (req, client, head) => {
    auths.push(req.headers["proxy-authorization"] ?? null);
    if (req.headers["proxy-authorization"] !== EGRESS_AUTH) {
      client.write("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
      client.destroy();
      return;
    }
    const [host, port] = (req.url ?? "").split(":");
    const target = net.connect(Number(port), host, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) target.write(head);
      client.pipe(target).pipe(client);
    });
    target.on("error", () => client.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as { port: number }).port;
  return {
    port,
    proxyUrl: `http://verify:pr0be@127.0.0.1:${port}`,
    sawProbeRequest: () => probeRequests,
    authAlwaysCorrect: () => auths.length > 0 && auths.every((a) => a === EGRESS_AUTH),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

interface UpstreamHandle {
  kind: "http" | "socks5";
  port: number;
  proxyUrl: string;
  sawProbeRequest: () => number;
  authAlwaysCorrect: () => boolean;
  close: () => Promise<void>;
}

/** Recording SOCKS5 upstream for the --socks5 egress proof. Enforces RFC 1929
 * user/pass, records what it saw, and actually dials the requested target so
 * the probe page genuinely loads through the chain. */
async function startRecordingSocks5Upstream(): Promise<UpstreamHandle> {
  let connects = 0;
  const auths: (string | null)[] = [];
  const EXPECT = { user: "verify", pass: "pr0be" };

  function makeReader(sock: net.Socket) {
    let pending = Buffer.alloc(0);
    let waiter: { n: number; res: (b: Buffer) => void; rej: (e: Error) => void } | null = null;
    const onData = (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      if (waiter && pending.length >= waiter.n) {
        const w = waiter;
        waiter = null;
        w.res(pending.subarray(0, w.n));
        pending = pending.subarray(w.n);
      }
    };
    const onErr = (err: Error) => {
      if (waiter) {
        const w = waiter;
        waiter = null;
        w.rej(err);
      }
    };
    sock.on("data", onData);
    sock.on("error", onErr);
    return {
      read(n: number): Promise<Buffer> {
        if (pending.length >= n) {
          const out = pending.subarray(0, n);
          pending = pending.subarray(n);
          return Promise.resolve(out);
        }
        return new Promise((res, rej) => {
          waiter = { n, res, rej };
        });
      },
      end() {
        sock.off("data", onData);
        sock.off("error", onErr);
        if (pending.length > 0) {
          sock.unshift(pending);
          pending = Buffer.alloc(0);
        }
      },
    };
  }

  const server = net.createServer((sock) => {
    void (async () => {
      const r = makeReader(sock);
      try {
        const greet = await r.read(2);
        const n = greet[1]!;
        const methods = await r.read(n);
        if (!methods.includes(0x02)) {
          auths.push(null);
          sock.write(Buffer.from([0x05, 0xff]));
          sock.end();
          return;
        }
        sock.write(Buffer.from([0x05, 0x02]));
        const ver = (await r.read(1))[0]!;
        const ulen = (await r.read(1))[0]!;
        const user = (await r.read(ulen)).toString("utf8");
        const plen = (await r.read(1))[0]!;
        const pass = (await r.read(plen)).toString("utf8");
        auths.push(`${user}:${pass}`);
        if (user !== EXPECT.user || pass !== EXPECT.pass) {
          sock.write(Buffer.from([ver, 0x01]));
          sock.end();
          return;
        }
        sock.write(Buffer.from([ver, 0x00]));
        const hdr = await r.read(4);
        const atyp = hdr[3]!;
        let host = "";
        if (atyp === 0x01) host = Array.from(await r.read(4)).join(".");
        else if (atyp === 0x03) {
          const len = (await r.read(1))[0]!;
          host = (await r.read(len)).toString("utf8");
        } else {
          sock.write(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          sock.end();
          return;
        }
        const port = (await r.read(2)).readUInt16BE(0);
        connects++;
        const onDialError = () => {
          // Pre-pipe dial failure: refuse the CONNECT, then quiet.
          sock.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          sock.end();
        };
        const target = net.connect(port, host, () => {
          target.removeListener("error", onDialError);
          sock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          r.end();
          // Permanent error handlers: piped writes fail with EPIPE as a
          // matter of course when either side hangs up; an unhandled 'error'
          // would crash the whole verify harness.
          sock.on("error", () => {
            sock.destroy();
            target.destroy();
          });
          target.on("error", () => {
            sock.destroy();
            target.destroy();
          });
          sock.pipe(target).pipe(sock);
        });
        target.on("error", onDialError);
      } catch {
        sock.destroy();
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as { port: number }).port;
  return {
    kind: "socks5",
    port,
    proxyUrl: `socks5://verify:pr0be@127.0.0.1:${port}`,
    sawProbeRequest: () => connects,
    authAlwaysCorrect: () => auths.length > 0 && auths.every((a) => a === `${EXPECT.user}:${EXPECT.pass}`),
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

  log(`verify: engine=${runtime.kind} dataDir=${args.dataDir} proxy=${args.proxy} socks5=${args.socks5}`);
  let session: BrowserSession | null = null;
  // Proxy modes: probe page on the LAN IP (loopback would bypass the proxy
  // and prove nothing), traffic routed through a recording fake upstream.
  const useUpstream = args.proxy || args.socks5;
  const probe = await serveProbePage(useUpstream ? lanIPv4() : "127.0.0.1");
  const upstream: UpstreamHandle | null = args.socks5
    ? await startRecordingSocks5Upstream()
    : args.proxy
      ? { kind: "http" as const, ...(await startRecordingUpstream()) }
      : null;
  // P7.9 proof inputs: the profile asks for the probe page as its start URL
  // and carries a bookmark set. The claims below check both materialized.
  profile.extra = {
    url: probe.url,
    bookmarkSets: [
      {
        id: "verify-set",
        name: "Verify",
        links: [{ name: "Probe", url: probe.url }],
      },
    ],
  };
  try {
    session = await runtime.launch({
      profile,
      identity,
      proxyUrl: upstream ? upstream.proxyUrl : null,
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

    // Proxy mode serves the probe page over plain HTTP on the LAN IP, which
    // is NOT a secure context — Chromium spec-hides userAgentData there, so
    // uach-consistent cannot be observed. Skip it, never fake it; the claim
    // is covered by the standard loopback run (16/16 on fury-core).
    if (args.proxy || args.socks5) {
      const idx = results.findIndex((r) => r.id === "uach-consistent");
      if (idx !== -1) {
        results[idx] = {
          id: "uach-consistent",
          pass: true,
          skipped: true,
          detail: "skipped: LAN-HTTP probe page is not a secure context; covered by the non-proxy run",
        };
      }
    }

    if (upstream) {
      const saw = upstream.sawProbeRequest();
      results.push({
        id: upstream.kind === "socks5" ? "egress-via-socks5" : "egress-via-proxy",
        pass: saw > 0 && upstream.authAlwaysCorrect(),
        detail:
          saw > 0 && upstream.authAlwaysCorrect()
            ? `upstream saw ${saw} proxied connection(s), credentials injected by the relay`
            : saw === 0
              ? "upstream saw ZERO connections — the engine bypassed the proxy (real-IP leak)"
              : "upstream saw connections with missing/wrong credentials",
      });

      // Diagnostics claim: the egress facts the launch recorded must exist
      // and still match an independent probe through the SAME relay. The
      // relay is static for the run, so a fresh check through it is a real
      // external probe of the same upstream chain — no rotation race.
      const diag = session?.egress ?? null;
      if (diag && diag.exitIp) {
        const now = await egressIpViaRelay(diag.relayPort!).catch(() => null);
        results.push({
          id: "diagnostics-egress",
          pass: now === diag.exitIp,
          detail:
            now === diag.exitIp
              ? `launch exit ${diag.exitIp} matches the live probe through relay :${diag.relayPort}`
              : `launch exit ${diag.exitIp} but live probe says ${now ?? "unreachable"} — diagnostics would mislead the operator`,
        });
      } else {
        results.push({
          id: "diagnostics-egress",
          pass: false,
          detail: "session recorded no egress facts (relay/exit-IP) for the diagnostics surface",
        });
      }
    }

    // P7.9 claims: start pages opened at launch, bookmark set materialized.
    // Both are engine-independent behaviors our runtime layer owns.
    {
      const norm = (u: string) => u.replace(/\/+$/, "");
      const targets = (await (
        await fetch(`http://127.0.0.1:${session.debugPort}/json`)
      ).json()) as { url?: string }[];
      const opened = targets.some((t) => norm(t.url ?? "") === norm(probe.url));
      results.push({
        id: "start-pages-launched",
        pass: opened,
        detail: opened
          ? `engine opened the profile start URL ${probe.url} at launch`
          : `no tab shows ${probe.url}; engine tabs: ${targets
              .map((t) => t.url ?? "?")
              .join(", ")
              .slice(0, 120)}`,
      });

      const bmPath = path.join(args.dataDir, "verify-profile", "Default", "Bookmarks");
      let bmPass = false;
      let bmDetail = "Bookmarks file not written";
      try {
        const bm = JSON.parse(fs.readFileSync(bmPath, "utf8")) as {
          roots?: { bookmark_bar?: { children?: { name?: string; meta_info?: Record<string, string>; children?: { url?: string }[] }[] } };
        };
        const folder = (bm.roots?.bookmark_bar?.children ?? []).find(
          (n) => n?.meta_info?.qp_set_id === "verify-set",
        );
        const link = folder?.children?.find((l) => (l.url ?? "").startsWith("http"));
        bmPass = Boolean(folder && link);
        bmDetail = bmPass
          ? `set "${folder!.name}" with ${folder!.children!.length} link(s) on the bar`
          : "managed folder/link missing from the bar";
      } catch (err) {
        bmDetail = `Bookmarks unreadable: ${err instanceof Error ? err.message : String(err)}`;
      }
      results.push({ id: "bookmark-sets", pass: bmPass, detail: bmDetail });
    }

    let failed = 0;
    let skipped = 0;
    for (const r of results) {
      if (r.skipped) {
        skipped++;
        log(`SKIP ${r.id} — ${r.detail}`);
        continue;
      }
      if (!r.pass) failed++;
      log(`${r.pass ? "PASS" : "FAIL"} ${r.id} — ${r.detail}`);
    }
    const held = results.length - failed - skipped;
    log(
      `verify: ${held}/${results.length} claims hold on ${runtime.kind}` +
        (skipped > 0 ? ` (${skipped} skipped, covered by the non-proxy run)` : ""),
    );
    return failed === 0 ? 0 : 1;
  } catch (err) {
    log(`verify: launch/harness failed: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  } finally {
    if (session) await session.stop().catch(() => {});
    if (upstream) await upstream.close().catch(() => {});
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
