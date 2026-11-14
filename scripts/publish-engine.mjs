#!/usr/bin/env node
// QueuePilot — publish our own compiled engine into the repo manifest.
//
// Packs the shippable subset of the official build out dir into
// C:\queuepilot-engine\dist\queuepilot-core-<ver>-windows-x64.tar.xz with the
// SAME internal layout the client already expects (Fury/chrome.exe), then
// updates engines.manifest.json in the repo: version -> 0.5.1-qp.N (N bumped
// per run), url -> file:/// tarball, sha256/sizeBytes recomputed.
//
// Loud failure, no silent degrade: any missing piece aborts before the
// manifest is touched. Widevine CDM is deliberately EXCLUDED (proprietary;
// redistributing needs a Google licence).
//
// Usage: node publish-engine.mjs
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

// Paths are overridable for other machines; defaults match the build host.
const OUT = process.env.QP_ENGINE_OUT ?? "C:\\queuepilot-engine\\src\\out\\windows-x64.noindex";
const DIST = process.env.QP_ENGINE_DIST ?? "C:\\queuepilot-engine\\dist";
// Repo root = parent of this script's scripts/ directory.
const REPO = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")));
const MANIFEST = path.join(REPO, "engines.manifest.json");
const VERSION_BASE = "0.5.5-qp";

function fail(msg) {
  console.error(`!! publish-engine: ${msg}`);
  process.exit(1);
}

if (!fs.existsSync(OUT)) fail(`out dir not found: ${OUT}`);

// 1. Find the browser binary produced by the official build.
const exeCandidates = ["chrome.exe", "fury.exe", "queuepilot.exe"];
const topEntries = fs.readdirSync(OUT);
const exe = exeCandidates.find((n) => topEntries.includes(n));
if (!exe) fail(`no browser exe in ${OUT} (looked for ${exeCandidates.join(", ")})`);
console.log(`==> binary: ${exe}`);

// 2. Stage Fury/ with the shippable subset.
const stage = path.join(DIST, "stage-publish");
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(path.join(stage, "Fury"), { recursive: true });

const FILE_RE = /\.(exe|dll|dat|pak|bin|json|manifest|sig|so)$/i;
const SKIP_FILES = new Set(["mini_installer.exe", "setup.exe", "chrome_pwa_launcher.exe"]);
const DIR_CANDIDATES = [
  "locales", "resources", "MEIPreload", "PrivacySandboxAttestationsPreloaded",
  "sskm", "Certificates", "Dictionaries", "hyphen-data",
];
let staged = 0;
for (const name of topEntries) {
  const src = path.join(OUT, name);
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    if (DIR_CANDIDATES.includes(name)) {
      fs.cpSync(src, path.join(stage, "Fury", name), { recursive: true });
      staged++;
    }
    continue;
  }
  if (!FILE_RE.test(name) || SKIP_FILES.has(name)) continue;
  if (/widevine/i.test(name)) continue; // proprietary, not ours to redistribute
  if (/\.pdb$/i.test(name)) continue;
  fs.copyFileSync(src, path.join(stage, "Fury", name));
  staged++;
}
// Widevine dir if present is excluded by DIR_CANDIDATES whitelist (not listed).
if (staged < 20) fail(`only ${staged} entries staged — out dir looks wrong, refusing to package`);
console.log(`==> staged ${staged} top-level entries + whitelisted dirs`);

// Ensure the client contract: Fury/chrome.exe must exist in the tarball.
const stagedFury = path.join(stage, "Fury");
if (exe !== "chrome.exe") {
  fs.copyFileSync(path.join(stagedFury, exe), path.join(stagedFury, "chrome.exe"));
  console.log(`==> layout compat: ${exe} also staged as chrome.exe`);
}

// 3. Version: bump -qp.N against what's pinned in the manifest.
const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
const entry = manifest.engines.find((e) => e.kind === "fury-core" && e.platform === "windows-x64");
if (!entry) fail("no fury-core/windows-x64 entry in engines.manifest.json");
let n = 1;
const m = /^(.+?)-qp\.(\d+)$/.exec(entry.version);
if (m) n = Number(m[2]) + 1;
const version = `${VERSION_BASE}.${n}`;

// 4. Pack tar.xz (bsdtar from System32 handles -J).
fs.mkdirSync(DIST, { recursive: true });
const tarball = path.join(DIST, `queuepilot-core-${version}-windows-x64.tar.xz`);
fs.rmSync(tarball, { force: true });
console.log(`==> packing ${tarball}`);
// Windows: tar parses the drive letter in an absolute output path as a remote
// host ("Cannot connect to C:"), so pack with a relative name from inside DIST.
execFileSync("tar", ["--force-local", "-cJf", path.basename(tarball), "-C", stage, "Fury"], { stdio: "inherit", cwd: DIST });
if (!fs.existsSync(tarball)) fail("tar produced no file");

// 5. Hash + size, then update the manifest atomically-ish.
const buf = fs.readFileSync(tarball);
const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
const sizeBytes = buf.length;
entry.version = version;
entry.url = `file:///${tarball.replace(/\\/g, "/")}`;
entry.sha256 = sha256;
entry.sizeBytes = sizeBytes;
entry.archive = "tar.xz";
entry.binaryPath = "Fury/chrome.exe";
fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
fs.rmSync(stage, { recursive: true, force: true });

console.log("==> manifest updated:");
console.log(JSON.stringify(entry, null, 2));
console.log(`OK publish-engine: ${version}`);
