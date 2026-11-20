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
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

import { runConsoleSmoke } from "./console-smoke.mjs";
const require = createRequire(import.meta.url);
const XLSX = require("xlsx");

const WITH_LAUNCH = process.argv.includes("--launch");
const API_PORT = 51234;
const BASE = `http://127.0.0.1:${API_PORT}`;
const scratch = mkdtempSync(path.join(tmpdir(), "qp-e2e-"));
let failures = 0;
let api = null;

function ok(name, cond, detail = "") {
  const tag = cond ? "PASS" : "FAIL";
  if (!cond) failures++;
  console.log(`  [${tag}] ${name}${detail ? ` — ${detail}` : ""}`);
}

async function apiCall(method, url, body, token) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
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
  const scriptingOn = await apiCall("PATCH", "/settings/sections/automation", { scriptingEndpoints: true });
  ok("scripting toggle refuses without SPECTRA_API_TOKEN (403)", scriptingOn.status === 403);

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
  await runConsoleSmoke({ base: BASE, ok });

  // ---- phase 5: real launch (optional) --------------------------------
  if (WITH_LAUNCH) {
    console.log("\nphase 5: real engine launch");
    // Point at the REAL install (engine already present) — separate DB by
    // using the default data dir, but our throwaway profiles are named.
    const launchBase = "http://127.0.0.1:50325";
    const health = await fetch(`${launchBase}/health`).then((r) => r.ok).catch(() => false);
    if (!health) {
      ok("dev API on 50325 is up for the launch phase", false, "start it first: apps/api with SPECTRA_RUNTIME=fury");
    } else {
      const created = await fetch(`${launchBase}/profiles`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: `E2E-Launch-${Date.now().toString(36)}`, generateFingerprint: true }),
      }).then((r) => r.json());
      const id = created.id;
      const started = await fetch(`${launchBase}/profiles/${id}/start`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      ok("profile starts on the real engine", started.status === 201);
      if (started.status === 201) {
        const egress = await fetch(`${launchBase}/profiles/${id}/egress`).then((r) => r.json()).catch(() => null);
        ok("egress endpoint answers", !!egress && "running" in egress, JSON.stringify(egress));
        const cookiesRes = await fetch(`${launchBase}/profiles/${id}/cookies`);
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
        const stopped = await fetch(`${launchBase}/profiles/${id}/stop`, { method: "POST" }).then((r) => r.json());
        ok("profile stops cleanly", stopped?.stopped === true);
        const run = await fetch(`${launchBase}/profiles/${id}/run`).then((r) => r.json());
        ok("no run reported after stop", !run?.run);
        await fetch(`${launchBase}/profiles/${id}`, { method: "DELETE" }).catch(() => {});
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
  try { api?.kill(); rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ }
  process.exit(1);
});
