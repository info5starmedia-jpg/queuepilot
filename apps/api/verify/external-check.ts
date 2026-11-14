import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Profile } from "@queuepilot/contracts";
import { FuryCoreRuntime, resolveFuryBinary } from "../src/application/runtime/fury-core.runtime.js";
import type { BrowserSession } from "../src/application/runtime/browser-runtime.js";
import { generateIdentity } from "../src/application/profiles/fingerprint-generator.js";
import { hostPrimaryDisplay } from "../src/application/profiles/host-display.js";
import { withPage } from "../src/application/runtime/cdp/cdp-page.js";

/**
 * P7.4 — external checker pass. Runs REAL third-party detection surfaces
 * against OUR binary, exactly as the product launches it:
 *
 *   npx tsx verify/external-check.ts --engine fury [--proxy-url socks5://...]
 *
 * - sannysoft (bot.sannysoft.com): the classic synthetic surface. Verdict
 *   rows carry a colored result cell (measured 2026-11-14: pass is
 *   rgb(200, 216, 109)); we read COMPUTED COLORS for the verdict, never CSS
 *   class names, so a site restyle cannot fake a pass. Row selection uses the
 *   site's own verdict-cell marker (td.result / td.passed / td.failed) —
 *   structure, not verdict.
 * - CreepJS: current site exposes percentage verdicts
 *   ("N% like headless / N% headless / N% stealth") instead of the retired
 *   trust-score line; both shapes are parsed, whichever the site serves.
 *
 * Honesty rules: a checker site being down or restructured is "unverifiable"
 * (never a pass, never a silent skip). Exit 1 only on a DEFINITIVE red
 * critical signal (webdriver caught, headless/stealth percentage high).
 */

interface SannyRow {
  name: string;
  result: string;
  verdict: "pass" | "fail" | "unknown";
}

interface CheckOutput {
  engine: string;
  ranAt: string;
  sannysoft: { ok: boolean; rows: SannyRow[]; note?: string };
  creepjs: {
    ok: boolean;
    trustScore: string | null;
    headlessPct: number | null;
    stealthPct: number | null;
    likeHeadlessPct: number | null;
    note?: string;
  };
  self: Record<string, unknown>;
}

const SANNY_URL = "https://bot.sannysoft.com/";
const CREEP_URL = "https://abrahamjuliot.github.io/creepjs/";

function parseArgs(argv: string[]): { engine: string; dataDir: string; proxyUrl: string | null } {
  const args = {
    engine: "fury",
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "queuepilot-extcheck-")),
    proxyUrl: null as string | null,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--engine") args.engine = argv[++i] ?? "fury";
    else if (argv[i] === "--data-dir") args.dataDir = argv[++i] ?? args.dataDir;
    else if (argv[i] === "--proxy-url") args.proxyUrl = argv[++i] ?? null;
  }
  return args;
}

async function waitFor(page: { evaluate: (e: string) => Promise<unknown> }, expression: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await page.evaluate(expression)) return true;
    } catch {
      /* page mid-navigation */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/**
 * Color the way a human reads it. sannysoft's pass green is a yellow-green
 * (200, 216, 109 measured 2026-11-14), so "green family" must not require
 * green to dominate red; red family stays strictly red-dominant. Anything
 * else is "unknown" — a restyled site degrades to unverifiable, never to
 * a guessed verdict.
 */
function colorVerdict(rgb: string): "pass" | "fail" | "unknown" {
  const m = /rgba?\((\d+)[, ]+(\d+)[, ]+(\d+)/.exec(rgb);
  if (!m) return "unknown";
  const r = Number(m[1]);
  const g = Number(m[2]);
  const b = Number(m[3]);
  if (g >= r - 20 && g > b + 20 && g > 120) return "pass";
  if (r > g + 40 && r > b + 40 && r > 120) return "fail";
  return "unknown";
}

export async function runExternalCheck(
  argv: string[],
  log: (m: string) => void = (m) => console.log(m),
): Promise<number> {
  const args = parseArgs(argv);
  const runtime =
    args.engine === "fury"
      ? new FuryCoreRuntime(resolveFuryBinary(args.dataDir))
      : (() => {
          throw new Error("external-check currently supports --engine fury");
        })();
  const identity = generateIdentity("windows", "UTC", "en-US", undefined, hostPrimaryDisplay());
  const profile: Profile = {
    id: "00000000-0000-4000-8000-000000000000",
    name: "extcheck-probe",
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

  const out: CheckOutput = {
    engine: runtime.kind,
    ranAt: new Date().toISOString(),
    sannysoft: { ok: false, rows: [] },
    creepjs: { ok: false, trustScore: null, headlessPct: null, stealthPct: null, likeHeadlessPct: null },
    self: {},
  };

  let session: BrowserSession | null = null;
  try {
    session = await runtime.launch({
      profile,
      identity,
      proxyUrl: args.proxyUrl,
      profileDataDir: path.join(args.dataDir, "extcheck-profile"),
    });
    // The bare ws://host:port root is NOT a valid CDP upgrade path — resolve
    // the browser target URL from /json/version exactly like verify/run.ts.
    let ws = session.wsEndpoint;
    if ("debugPort" in session && typeof (session as { debugPort: unknown }).debugPort === "number") {
      const debugPort = (session as { debugPort: number }).debugPort;
      for (let attempt = 0; attempt < 20; attempt++) {
        try {
          const res = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
          if (res.ok) {
            const info = (await res.json()) as { webSocketDebuggerUrl?: string };
            if (info.webSocketDebuggerUrl) {
              ws = info.webSocketDebuggerUrl;
              break;
            }
          }
        } catch {
          /* debug port not up yet */
        }
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    // --- Self facts from the same browser, for cross-checking the checkers.
    out.self = (await withPage(ws, "https://example.com/", (page) =>
      page.evaluate(`({
        webdriver: navigator.webdriver,
        ua: navigator.userAgent,
        platform: navigator.platform,
        chrome: typeof window.chrome,
        plugins: navigator.plugins.length,
      })`),
    )) as Record<string, unknown>;

    // --- Sannysoft ----------------------------------------------------------
    await withPage(ws, SANNY_URL, async (page) => {
      const ready = await waitFor(
        page,
        `document.readyState === 'complete' && document.body.innerText.length > 200`,
        20_000,
      );
      if (!ready) {
        out.sannysoft.note = "page did not render in 20s (network/site issue)";
        return;
      }
      // Give the async tests a moment, then read verdict rows: the site's own
      // verdict cell (td.result / td.passed / td.failed) marks WHICH rows
      // carry verdicts; the verdict itself comes from the computed color.
      await new Promise((r) => setTimeout(r, 3000));
      const rows = (await page.evaluate(`(() => {
        const out = [];
        for (const td of document.querySelectorAll('td.result, td.passed, td.failed')) {
          const tr = td.closest('tr');
          const nameCell = tr ? tr.querySelector('td, th') : null;
          const name = nameCell ? nameCell.innerText.trim().replace(/\\s+/g, ' ') : '?';
          out.push({
            name,
            result: td.innerText.trim().replace(/\\s+/g, ' ').slice(0, 80),
            color: getComputedStyle(td).backgroundColor,
          });
        }
        return out;
      })()`)) as { name: string; result: string; color: string }[];
      out.sannysoft.rows = rows.map((r) => ({
        name: r.name,
        result: r.result,
        verdict: colorVerdict(r.color),
      }));
      out.sannysoft.ok = rows.length > 0;
      if (rows.length === 0) out.sannysoft.note = "no verdict rows found — site structure changed?";
    });

    // --- CreepJS -------------------------------------------------------------
    await withPage(ws, CREEP_URL, async (page) => {
      const ready = await waitFor(
        page,
        `/trust score|like headless|% headless|% stealth/i.test(document.body.innerText)`,
        45_000,
      );
      if (!ready) {
        out.creepjs.note = "no verdict text within 45s — site structure changed or network issue";
        return;
      }
      await new Promise((r) => setTimeout(r, 3000)); // analysis settles slowly
      const text = String(await page.evaluate(`document.body.innerText`));
      const score = /trust score[^\d]*(\d{1,3}(?:\.\d+)?%)/i.exec(text);
      out.creepjs.trustScore = score?.[1] ?? null;
      const pct = (label: string): number | null => {
        const m = new RegExp(`(\\d{1,3}(?:\\.\\d+)?)%\\s*${label}`, "i").exec(text);
        return m ? Number(m[1]) : null;
      };
      out.creepjs.likeHeadlessPct = pct("like headless");
      out.creepjs.headlessPct = pct("headless");
      out.creepjs.stealthPct = pct("stealth");
      out.creepjs.ok =
        out.creepjs.trustScore !== null ||
        out.creepjs.headlessPct !== null ||
        out.creepjs.stealthPct !== null;
      if (!out.creepjs.ok) {
        out.creepjs.note = "neither trust score nor headless/stealth percentages found — site structure changed?";
      }
    });

    // --- Verdict --------------------------------------------------------------
    const sannyFails = out.sannysoft.rows.filter((r) => r.verdict === "fail");
    const webdriverRows = out.sannysoft.rows.filter((r) => /webdriver/i.test(r.name));
    const webdriverCaught = webdriverRows.some(
      (r) => r.verdict === "fail" && !/missing|passed|false/i.test(r.result),
    );
    const trust = out.creepjs.trustScore ? Number(out.creepjs.trustScore.replace("%", "")) : null;
    const headlessBad = out.creepjs.headlessPct !== null && out.creepjs.headlessPct >= 50;
    const stealthBad = out.creepjs.stealthPct !== null && out.creepjs.stealthPct >= 50;
    const criticalRed = webdriverCaught || (trust !== null && trust < 50) || headlessBad || stealthBad;

    log(`self: webdriver=${String(out.self.webdriver)} ua=${String(out.self.ua)}`);
    for (const r of out.sannysoft.rows) {
      log(`sannysoft [${r.verdict}] ${r.name} — ${r.result}`);
    }
    log(
      `creepjs: trust=${out.creepjs.trustScore ?? "?"} headless=${out.creepjs.headlessPct ?? "?"}% ` +
        `stealth=${out.creepjs.stealthPct ?? "?"}% (${out.creepjs.note ?? "ok"})`,
    );
    log(
      `external-check: sannysoft ${out.sannysoft.ok ? `${sannyFails.length} red row(s), ${out.sannysoft.rows.length} verdict rows` : "UNVERIFIABLE"}, ` +
        `creepjs ${out.creepjs.ok ? "verdicts read" : "UNVERIFIABLE"}`,
    );
    if (criticalRed) {
      log("external-check: CRITICAL red signal — definitive bot detection");
      return 1;
    }
    return out.sannysoft.ok || out.creepjs.ok ? 0 : 2;
  } catch (err) {
    log(`external-check: harness failed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
    return 2;
  } finally {
    if (session) await session.stop().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, "/")}`).href) {
  runExternalCheck(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(2);
    },
  );
}
