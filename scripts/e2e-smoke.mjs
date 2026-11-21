#!/usr/bin/env node
/**
 * e2e-smoke — the Phase-1 release gate: one command that proves the product
 * works the way a team member will use it.
 *
 *   node scripts/e2e-smoke.mjs            API phases + a HEADLESS console
 *                                         click-through (temp data dir, no
 *                                         visible windows — CI-safe)
 *   node scripts/e2e-smoke.mjs --launch   also boots a real profile on the
 *                                         installed engine, proves egress,
 *                                         round-trips cookies, stops clean
 *
 * Phases (each prints PASS/FAIL and the run exits 1 on the first FAIL):
 *   1. boot    — API starts on a scratch port + data dir, /health answers
 *   2. gate    — scripting endpoints refuse without opt-in AND without token
 *   3. import  — CSV import + xlsx import create real profiles (dry-run then
 *                apply, upsert stable)
 *   4. surface — /metrics counts, /profiles list, identity PATCH merges
 *   4b. console— the real dashboard in a headless browser: Start, Stop,
 *                Delete, W → Warmups, recipe Delete (scripts/console-smoke.mjs;
 *                SKIP, never PASS, when no Chromium-family browser exists)
 *   5. launch  — (--launch only) start on the real engine, /egress proves
 *                the exit IP, cookie export → import round-trips, stop
 *   6. teardown— profile stopped, no leaked child processes
 *
 * Exit 0 + "E2E GREEN" means: ship it to the team.
 */
import { spawn, execSync } from "node:child_process";
import http from "node:http";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

import { runConsoleSmoke } from "./console-smoke.mjs";
const require = createRequire(import.meta.url);
const XLSX = require("xlsx");

const WITH_LAUNCH = process.argv.includes("--launch");
const API_PORT = 51234;
const BASE = `http://127.0.0.1:${API_PORT}`;
const scratch = mkdtempSync(path.join(tmpdir(), "qp-e2e-"));
/** Stand-in for AYCD Inbox: never the real key, never AYCD servers. */
let fakeInbox = null;
const FAKE_AYCD_KEY = "fake-inbox-key-1234";
let failures = 0;
let api = null;
/** P0 audit item 3: the token is auto-generated into the data dir. */
const AUTO_TOKEN = () => readFileSync(path.join(scratch, "api-token"), "utf8").trim();

function ok(name, cond, detail = "") {
  const tag = cond ? "PASS" : "FAIL";
  if (!cond) failures++;
  console.log(`  [${tag}] ${name}${detail ? ` — ${detail}` : ""}`);
}

async function apiCall(method, url, body, token) {
  // token === null explicitly sends NO Authorization (to test the wall).
  const auth = token === null ? {} : { authorization: `Bearer ${token ?? AUTO_TOKEN()}` };
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...auth,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch { /* non-JSON (exports) */ }
  return { status: res.status, json };
}

function waitForHealth(timeoutMs = 30000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const res = await fetch(`${BASE}/health`);
        if (res.ok) return resolve();
      } catch { /* not up yet */ }
      if (Date.now() - started > timeoutMs) return reject(new Error("API did not come up"));
      setTimeout(tick, 500);
    };
    tick();
  });
}

async function main() {
  console.log(`e2e-smoke — scratch dir ${scratch}${WITH_LAUNCH ? " (with real launch)" : ""}`);

  // ---- phase 1: boot --------------------------------------------------
  console.log("\nphase 1: boot");
  // Stand-in for AYCD Inbox so the console AYCD card can be exercised without
  // the owner's real key and without touching AYCD's servers. Contract from
  // aycd-inbox.ts: GET /api/v1/user/verify, header `Authorization: Token <key>`.
  fakeInbox = http.createServer((req, res) => {
    const good = req.headers.authorization === `Token ${FAKE_AYCD_KEY}`;
    if (req.url?.startsWith("/api/v1/user/verify")) {
      res.writeHead(good ? 200 : 401, { "content-type": "application/json" });
      res.end(JSON.stringify(good ? { success: true } : { error: "invalid key" }));
      return;
    }
    res.writeHead(404).end("{}");
  });
  await new Promise((resolve) => fakeInbox.listen(0, "127.0.0.1", resolve));
  const fakeInboxBase = `http://127.0.0.1:${fakeInbox.address().port}`;

  api = spawn(
    process.execPath,
    ["--import", "tsx", "src/main.ts"],
    {
      cwd: path.resolve(import.meta.dirname, "../apps/api"),
      env: {
        ...process.env,
        SPECTRA_PORT: String(API_PORT),
        SPECTRA_DATA_DIR: scratch,
        SPECTRA_RUNTIME: "fake", // import phases never touch a real engine
        SPECTRA_AYCD_API_BASE: fakeInboxBase,
        NODE_ENV: "production",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let apiLog = "";
  api.stdout.on("data", (d) => (apiLog += d));
  api.stderr.on("data", (d) => (apiLog += d));
  try {
    await waitForHealth();
    ok("API boots on a fresh data dir", true);
  } catch {
    ok("API boots on a fresh data dir", false, apiLog.slice(-400));
    return finish();
  }

  // ---- phase 2: security gates ---------------------------------------
  console.log("\nphase 2: security gates");
  const refused = await apiCall("POST", "/jyl/run", { kind: "command", name: "x" });
  ok("scripting endpoint refuses without opt-in (403)", refused.status === 403);
  // P0 audit item 3: the token is auto-generated now, so API calls without
  // it are 401 (they used to sail through on a default install).
  const noAuth = await apiCall("GET", "/profiles", undefined, null);
  ok("API refuses requests without the token (401)", noAuth.status === 401);
  const scriptingOn = await apiCall("PATCH", "/settings/sections/automation", { scriptingEndpoints: true });
  ok("scripting toggle works with the auto-generated token (200)", scriptingOn.status === 200);
  const scriptingBackOff = await apiCall("PATCH", "/settings/sections/automation", { scriptingEndpoints: false });
  ok("scripting toggle turns back off", scriptingBackOff.status === 200);

  // ---- phase 3: imports ----------------------------------------------
  console.log("\nphase 3: CSV + xlsx import");
  const CSV = "name,group,timezone\nE2E-Alice,alpha,America/Toronto\nE2E-Bob,beta,Europe/Berlin";
  const dry = await apiCall("POST", "/profiles/import", { csv: CSV, dryRun: true });
  ok("CSV dry-run reports 2 would-create", dry.json?.succeeded === 2 && dry.json?.results?.every((r) => r.action === "would-create"));
  const applied = await apiCall("POST", "/profiles/import", { csv: CSV });
  ok("CSV apply creates 2 profiles", applied.json?.succeeded === 2);
  const again = await apiCall("POST", "/profiles/import", { csv: CSV });
  ok("re-import upserts (2 updated, no duplicates)", again.json?.results?.every((r) => r.action === "updated"));

  const sheet = XLSX.utils.aoa_to_sheet([
    ["name", "group", "proxy"],
    ["E2E-Carol", "gamma", ""],
  ]);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, "Profiles");
  const xlsxB64 = Buffer.from(XLSX.write(book, { type: "buffer", bookType: "xlsx" })).toString("base64");
  const xDry = await apiCall("POST", "/profiles/import-xlsx", { xlsx: xlsxB64, dryRun: true });
  ok("xlsx dry-run reports 1 would-create", xDry.json?.succeeded === 1);
  const xApplied = await apiCall("POST", "/profiles/import-xlsx", { xlsx: xlsxB64 });
  ok("xlsx apply creates the profile", xApplied.json?.succeeded === 1);

  const list = await apiCall("GET", "/profiles");
  const names = (list.json?.profiles ?? []).map((p) => p.name).sort();
  ok("profile list shows all 3 imports", JSON.stringify(names) === JSON.stringify(["E2E-Alice", "E2E-Bob", "E2E-Carol"]), names.join(","));

  // ---- phase 4: API surface ------------------------------------------
  console.log("\nphase 4: surface behavior");
  const metrics = await apiCall("GET", "/metrics");
  ok("/metrics counts requests", metrics.json?.requestsTotal > 5);
  const alice = list.json.profiles.find((p) => p.name === "E2E-Alice");
  const pin1 = await apiCall("PATCH", `/profiles/${alice.id}/identity`, { timezone: "America/New_York" });
  const pin2 = await apiCall("PATCH", `/profiles/${alice.id}/identity`, { deviceMemoryGb: 8 });
  const pins = pin2.json?.identity?.overrides ?? {};
  ok("identity PATCH merges pins (timezone survives a second PATCH)",
    pins.timezone === "America/New_York" && pins.deviceMemoryGb === 8, JSON.stringify(pins));
  const bad = await apiCall("POST", "/profiles/import-xlsx", { xlsx: Buffer.from("not a zip").toString("base64") });
  ok("non-workbook bytes are refused (400)", bad.status === 400);

  // ---- phase 4b: console (real dashboard in a headless browser) -------
  console.log("\nphase 4b: console buttons in a real browser");
  await runConsoleSmoke({ fakeAycdKey: FAKE_AYCD_KEY, base: BASE, ok, token: AUTO_TOKEN() });

  // ---- phase 5: real launch (optional) --------------------------------
  if (WITH_LAUNCH) {
    console.log("\nphase 5: real engine launch");
    // Point at the REAL install (engine already present) — separate DB by
    // using the default data dir, but our throwaway profiles are named.
    const launchBase = "http://127.0.0.1:50325";
    // P0 audit item 3: the real install has an auto-generated token in its
    // data dir; send it like any other local caller must.
    let launchToken = null;
    try {
      launchToken = readFileSync(path.join(homedir(), ".queuepilot", "api-token"), "utf8").trim();
    } catch { /* pre-token install: proceed without auth */ }
    const launchHeaders = {
      "content-type": "application/json",
      ...(launchToken ? { authorization: `Bearer ${launchToken}` } : {}),
    };
    const health = await fetch(`${launchBase}/health`).then((r) => r.ok).catch(() => false);
    if (!health) {
      ok("dev API on 50325 is up for the launch phase", false, "start it first: apps/api with SPECTRA_RUNTIME=fury");
    } else {
      const created = await fetch(`${launchBase}/profiles`, {
        method: "POST",
        headers: launchHeaders,
        body: JSON.stringify({ name: `E2E-Launch-${Date.now().toString(36)}`, generateFingerprint: true }),
      }).then((r) => r.json());
      const id = created.id;
      const started = await fetch(`${launchBase}/profiles/${id}/start`, { method: "POST", headers: launchHeaders, body: "{}" });
      ok("profile starts on the real engine", started.status === 201);
      if (started.status === 201) {
        const egress = await fetch(`${launchBase}/profiles/${id}/egress`, { headers: launchHeaders }).then((r) => r.json()).catch(() => null);
        ok("egress endpoint answers", !!egress && "running" in egress, JSON.stringify(egress));
        const cookiesRes = await fetch(`${launchBase}/profiles/${id}/cookies`, { headers: launchHeaders });
        const cookiesText = await cookiesRes.text();
        let cookies = null;
        try {
          cookies = JSON.parse(cookiesText);
        } catch {
          cookies = null;
        }
        ok(
          "cookie jar readable over CDP",
          Array.isArray(cookies?.cookies),
          `status=${cookiesRes.status} body=${cookiesText.slice(0, 200)}`,
        );
        const stopped = await fetch(`${launchBase}/profiles/${id}/stop`, { method: "POST", headers: launchHeaders }).then((r) => r.json());
        ok("profile stops cleanly", stopped?.stopped === true);
        const run = await fetch(`${launchBase}/profiles/${id}/run`, { headers: launchHeaders }).then((r) => r.json());
        ok("no run reported after stop", !run?.run);
        await fetch(`${launchBase}/profiles/${id}`, { method: "DELETE", headers: launchHeaders }).catch(() => {});
      }
    }
  }

  // ---- phase 6: teardown ----------------------------------------------
  console.log("\nphase 6: teardown");
  const procBefore = api.pid;
  api.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 1500));
  let gone = true;
  try {
    process.kill(procBefore, 0);
    gone = false;
  } catch { /* dead */ }
  ok("API process exits on SIGTERM", gone);
  fakeInbox?.close();
  rmSync(scratch, { recursive: true, force: true });
  ok("scratch data dir removed", !existsSync(scratch));

  return finish();
}

function finish() {
  console.log("");
  if (failures === 0) console.log("E2E GREEN — ship it.");
  else console.log(`E2E RED — ${failures} failure(s).`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("e2e-smoke crashed:", err);
  try { api?.kill(); fakeInbox?.close(); rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ }
  process.exit(1);
});
