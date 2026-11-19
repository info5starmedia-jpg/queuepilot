#!/usr/bin/env node
// QueuePilot — publish our own compiled engine into the repo manifest.
//
// Packs the shippable subset of the official build out dir into
// C:\queuepilot-engine\dist\queuepilot-core-<ver>-windows-x64.tar.xz with the
// SAME internal layout the client already expects (Fury/chrome.exe), then
// writes the entry into engines.manifest.json in the repo (url -> file:///
// tarball, sha256/sizeBytes recomputed).
//
// Loud failure, no silent degrade: any missing piece aborts before the
// manifest is touched. Widevine CDM is deliberately EXCLUDED (proprietary;
// redistributing needs a Google licence).
//
// Usage:
//   node publish-engine.mjs [--out <dir>] [--chromium <x.y.z.w>] [--version <v>] [--append]
//
//   --out       build out dir (default $QP_ENGINE_OUT or ...\out\windows-x64.noindex)
//   --chromium  the Chromium version this package must contain. The out dir
//               must hold "<x.y.z.w>.manifest" (the build writes one per
//               version). Without it, the out dir must hold exactly ONE such
//               file. 158 finding: an out dir reused across milestones keeps
//               the old version's manifest, and the default out dir held the
//               157 build — a bare run would have packed 157 under a new
//               version number with a perfectly valid hash.
//   --version   package version to write (e.g. 0.5.6-qp.2). Default: bump
//               -qp.N of the existing entry, as before.
//   --append    add a NEW manifest entry and keep the existing ones. Default
//               (as before): replace the fury-core/windows-x64 entry.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

function fail(msg) {
  console.error(`!! publish-engine: ${msg}`);
  process.exit(1);
}

const args = { append: false };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === "--out") args.out = process.argv[++i];
  else if (a === "--chromium") args.chromium = process.argv[++i];
  else if (a === "--version") args.version = process.argv[++i];
  else if (a === "--append") args.append = true;
  else fail(`unknown argument: ${a}`);
}
if (args.version && !/^\d+\.\d+\.\d+-qp\.\d+$/.test(args.version)) fail(`--version must look like 0.5.6-qp.2 (got ${args.version})`);
if (args.chromium && !/^\d+\.\d+\.\d+\.\d+$/.test(args.chromium)) fail(`--chromium must look like 159.0.8154.13 (got ${args.chromium})`);

// Paths are overridable for other machines; defaults match the build host.
const OUT = args.out ?? process.env.QP_ENGINE_OUT ?? "C:\\queuepilot-engine\\src\\out\\windows-x64.noindex";
const DIST = process.env.QP_ENGINE_DIST ?? "C:\\queuepilot-engine\\dist";
// Repo root = parent of this script's scripts/ directory.
const REPO = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")));
const MANIFEST = path.join(REPO, "engines.manifest.json");
const VERSION_BASE = "0.5.5-qp";
const VERSION_MANIFEST_RE = /^\d+\.\d+\.\d+\.\d+\.manifest$/;

if (!fs.existsSync(OUT)) fail(`out dir not found: ${OUT}`);

// 1. Find the browser binary produced by the official build.
const exeCandidates = ["chrome.exe", "fury.exe", "queuepilot.exe"];
const topEntries = fs.readdirSync(OUT);
const exe = exeCandidates.find((n) => topEntries.includes(n));
if (!exe) fail(`no browser exe in ${OUT} (looked for ${exeCandidates.join(", ")})`);
console.log(`==> binary: ${exe}`);

// 1b. Which Chromium is this? Refuse a mismatched or ambiguous out dir.
const versionManifests = topEntries.filter((n) => VERSION_MANIFEST_RE.test(n));
let chromium;
if (args.chromium) {
  if (!versionManifests.includes(`${args.chromium}.manifest`)) {
    fail(`out dir has no ${args.chromium}.manifest (found: ${versionManifests.join(", ") || "none"}) — not that build, refusing`);
  }
  chromium = args.chromium;
} else {
  if (versionManifests.length !== 1) {
    fail(`out dir holds ${versionManifests.length} version manifests (${versionManifests.join(", ")}); pass --chromium <version>`);
  }
  chromium = versionManifests[0].replace(/\.manifest$/, "");
}
console.log(`==> chromium: ${chromium}`);

// 2. Stage Fury/ with the shippable subset.
const stage = path.join(DIST, "stage-publish");
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(path.join(stage, "Fury"), { recursive: true });

const FILE_RE = /\.(exe|dll|dat|pak|bin|json|manifest|sig|so)$/i;
// t.exe: a test helper non-official builds leave in the out dir.
const SKIP_FILES = new Set(["mini_installer.exe", "setup.exe", "chrome_pwa_launcher.exe", "t.exe"]);
const DIR_CANDIDATES = [
  "locales", "resources", "MEIPreload", "PrivacySandboxAttestationsPreloaded",
  "sskm", "Certificates", "Dictionaries", "hyphen-data",
];
// Pseudo-locales (ar-XB, en-XA) are test locales; official Chrome never ships them.
const PSEUDO_LOCALE_RE = /[\\/](ar-XB|en-XA)[^\\/]*$/;
let staged = 0;
for (const name of topEntries) {
  const src = path.join(OUT, name);
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    if (DIR_CANDIDATES.includes(name)) {
      fs.cpSync(src, path.join(stage, "Fury", name), { recursive: true, filter: (f) => !PSEUDO_LOCALE_RE.test(f) });
      staged++;
    }
    continue;
  }
  if (!FILE_RE.test(name) || SKIP_FILES.has(name)) continue;
  if (/widevine/i.test(name)) continue; // proprietary, not ours to redistribute
  if (/\.pdb$/i.test(name)) continue;
  if (VERSION_MANIFEST_RE.test(name) && name !== `${chromium}.manifest`) continue; // stale milestone
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

// 3. Version: explicit, or bump -qp.N against what's pinned in the manifest.
const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
const existing = manifest.engines.filter((e) => e.kind === "fury-core" && e.platform === "windows-x64");
let version = args.version;
if (!version) {
  const entry = existing.at(-1);
  if (!entry) fail("no fury-core/windows-x64 entry in engines.manifest.json");
  let n = 1;
  const m = /^(.+?)-qp\.(\d+)$/.exec(entry.version);
  if (m) n = Number(m[2]) + 1;
  version = `${VERSION_BASE}.${n}`;
}
if (args.append && existing.some((e) => e.version === version)) {
  fail(`manifest already has ${version} — refusing to append a duplicate`);
}

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
const fields = {
  kind: "fury-core",
  version,
  platform: "windows-x64",
  url: `file:///${tarball.replace(/\\/g, "/")}`,
  sha256: crypto.createHash("sha256").update(buf).digest("hex"),
  sizeBytes: buf.length,
  archive: "tar.xz",
  binaryPath: "Fury/chrome.exe",
};
let written;
if (args.append) {
  manifest.engines.push(fields);
  written = fields;
} else {
  const entry = existing.at(-1);
  if (!entry) fail("no fury-core/windows-x64 entry in engines.manifest.json");
  written = Object.assign(entry, fields);
}
fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
fs.rmSync(stage, { recursive: true, force: true });

console.log(`==> manifest ${args.append ? "appended" : "updated"} (chromium ${chromium}):`);
console.log(JSON.stringify(written, null, 2));
console.log(`OK publish-engine: ${version}`);
