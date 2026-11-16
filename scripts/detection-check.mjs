#!/usr/bin/env node
/**
 * External detection-checker harness (P4, v0.16.0).
 *
 * The claim suite (25) and Fury harness (43) prove the engine's INTERNAL
 * coherence. This harness is the EXTERNAL leg: it launches a real profile,
 * opens CreepJS + sannysoft, snapshots our own attestation verdict beside
 * them, and writes a report the operator fills in after eyeballing the two
 * checker pages in the live browser.
 *
 * Usage:
 *   node scripts/detection-check.mjs --profile <name-or-id>
 *     [--api http://127.0.0.1:50325] [--token <apiToken>]
 *     [--keep-running]            (default: stops the profile on exit)
 *
 * What it does NOT do: read the checker pages' verdicts for you. CreepJS's
 * trust score and sannysoft's red/green table are visual — that's the
 * operator's pass, on a machine with the real fury-core engine installed.
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const CHECKERS = [
  { name: "CreepJS", url: "https://abrahamjuliot.github.io/creepjs/" },
  { name: "sannysoft", url: "https://arh.antoinevastel.com/bots/areyouheadless" },
];

function parseArgs(argv) {
  const args = { api: "http://127.0.0.1:50325", keepRunning: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--profile") args.profile = argv[++i];
    else if (a === "--api") args.api = argv[++i];
    else if (a === "--token") args.token = argv[++i];
    else if (a === "--keep-running") args.keepRunning = true;
    else if (a === "--help" || a === "-h") {
      console.log("node scripts/detection-check.mjs --profile <name-or-id> [--api url] [--token t] [--keep-running]");
      process.exit(0);
    } else {
      console.error(`unknown argument: ${a}`);
      process.exit(2);
    }
  }
  if (!args.profile) {
    console.error("--profile is required (profile name or id)");
    process.exit(2);
  }
  return args;
}

async function api(args, method, url, body) {
  const res = await fetch(`${args.api}${url}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(args.token ? { authorization: `Bearer ${args.token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, json, text };
}

async function main() {
  const args = parseArgs(process.argv);

  // --- resolve the profile ---
  const listRes = await api(args, "GET", "/profiles");
  if (listRes.status !== 200) {
    console.error(`API not reachable at ${args.api} (status ${listRes.status})`);
    process.exit(1);
  }
  const profiles = listRes.json.profiles;
  const profile =
    profiles.find((p) => p.id === args.profile) ||
    profiles.find((p) => p.name.toLowerCase() === args.profile.toLowerCase());
  if (!profile) {
    console.error(`no profile named or id'd "${args.profile}" (${profiles.length} profiles exist)`);
    process.exit(1);
  }
  console.log(`profile: ${profile.name} (${profile.id})`);

  // --- start if idle ---
  const wasRunning = profile.status === "running";
  if (!wasRunning) {
    const start = await api(args, "POST", `/profiles/${profile.id}/start`, {});
    if (start.status !== 201 && start.status !== 200) {
      console.error(`start failed: ${start.status} ${start.text}`);
      process.exit(1);
    }
    console.log("profile started");
  }

  // --- open the checkers, staggered so both actually load ---
  const open = await api(args, "POST", `/profiles/${profile.id}/tabs/bulk-open`, {
    urls: CHECKERS.map((c) => c.url),
    staggerMs: 1500,
  });
  if (open.status !== 201 && open.status !== 200) {
    console.error(`bulk-open failed: ${open.status} ${open.text}`);
    process.exit(1);
  }
  for (const r of open.json.results) {
    console.log(`  opened ${r.url} — ${r.error ? `ERROR ${r.error}` : "ok"}`);
  }

  // --- our own machine-verifiable leg: attestation + egress ---
  const attest = await api(args, "GET", `/profiles/${profile.id}/attest`);
  const egress = await api(args, "GET", `/profiles/${profile.id}/egress`);

  // --- report ---
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const reportPath = path.join("docs", "reports", `detection-check-${profile.name}-${stamp}.md`);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  const report = `# Detection check — ${profile.name}

Date: ${new Date().toISOString()}
Profile: ${profile.name} (${profile.id})
Engine: ${egress.json?.engineKind ?? "unknown"} · proxy: ${egress.json?.proxyUrl ?? "none"}

## Machine leg (attestation — snapshot vs live engine)

verdict: **${attest.json?.verdict ?? attest.text}**

\`\`\`json
${JSON.stringify(attest.json?.observed ?? attest.json ?? null, null, 2)}
\`\`\`

## Manual leg — review these tabs in the open browser, then record below

- [ ] **CreepJS** — ${CHECKERS[0].url}
      trust score ≥ 70? fingerprint stable across reload? no "lies" section entries?
- [ ] **sannysoft** — ${CHECKERS[1].url}
      all rows green / "yes" where expected? WebGL & permissions not flagged?

### Operator findings

(creepjs trust score: ___  ·  sannysoft flags: ___  ·  reload-stability: ___)

## Verdict

- [ ] PASS — no external checker flags; ship this engine build
- [ ] FAIL — flags recorded above; attach screenshot, file a P4 fix item
`;
  fs.writeFileSync(reportPath, report);
  console.log(`\nreport written: ${reportPath}`);
  console.log("\nThe two checker tabs are open in the profile's browser.");
  console.log("Review them, edit the report's findings + verdict, then return here.");

  if (args.keepRunning) {
    console.log("--keep-running: profile left running.");
    return;
  }
  await new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question("\nPress Enter to stop the profile and exit… ", () => {
      rl.close();
      resolve();
    });
  });
  if (!wasRunning) {
    await api(args, "POST", `/profiles/${profile.id}/stop`);
    console.log("profile stopped.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
