#!/usr/bin/env node
/**
 * Publish engine updates to the hosted QueuePilot server.
 *
 * The desktop app's update-client (Settings → Engine → Update server URL)
 * expects an engines.manifest.json plus the tarballs it references. This
 * script takes the local engines.manifest.json (produced by the engine
 * build), uploads each tarball to the server, and writes a HOSTED copy of
 * the manifest whose `url` fields point at https://<domain>/updates/....
 *
 * Usage (from the repo root, after an engine build produced the tarball):
 *   node deploy/publish-engine.mjs --version 0.5.5-qp.4
 *   node deploy/publish-engine.mjs            # publish every manifest entry
 *
 * Required env:
 *   QP_SERVER_HOST     e.g. root@107.172.193.23
 *   QP_SERVER_DOMAIN   e.g. queuepilot.taskpilot.tech
 * Optional env:
 *   QP_SSH_KEY         path to a private key (default: ssh agent/password)
 *   QP_MANIFEST        local manifest path (default: ./engines.manifest.json)
 *   QP_REMOTE_DIR      server updates dir (default: /opt/queuepilot-server/data/updates)
 *
 * Idempotent: re-publishing the same version just rewrites the same file.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const onlyVersion = flag("version");

const HOST = process.env.QP_SERVER_HOST;
const DOMAIN = process.env.QP_SERVER_DOMAIN ?? "queuepilot.taskpilot.tech";
const MANIFEST_PATH = resolve(process.env.QP_MANIFEST ?? "engines.manifest.json");
const REMOTE_DIR = process.env.QP_REMOTE_DIR ?? "/opt/queuepilot-server/data/updates";
const ssh = (cmd) => {
  const opts = ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new"];
  if (process.env.QP_SSH_KEY) opts.push("-i", process.env.QP_SSH_KEY);
  return execFileSync("ssh", [...opts, HOST, cmd], { stdio: ["ignore", "pipe", "pipe"] }).toString();
};
const scp = (local, remote) => {
  const opts = ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new"];
  if (process.env.QP_SSH_KEY) opts.push("-i", process.env.QP_SSH_KEY);
  execFileSync("scp", [...opts, local, `${HOST}:${remote}`], { stdio: "inherit" });
};

if (!HOST) {
  console.error("QP_SERVER_HOST is required, e.g. root@107.172.193.23");
  process.exit(1);
}
if (!existsSync(MANIFEST_PATH)) {
  console.error(`manifest not found: ${MANIFEST_PATH}`);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
const entries = manifest.engines.filter((e) => !onlyVersion || e.version === onlyVersion);
if (entries.length === 0) {
  console.error(`no manifest entries matched version ${onlyVersion}`);
  process.exit(1);
}

ssh(`mkdir -p ${REMOTE_DIR}`);
console.log(`server: ${HOST}  dir: ${REMOTE_DIR}  domain: ${DOMAIN}`);

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

// Upload each tarball the manifest references.
for (const entry of entries) {
  if (!entry.url.startsWith("file://")) {
    console.log(`skip ${entry.version}: url is not a local file:// reference (${entry.url})`);
    continue;
  }
  const local = resolve(entry.url.slice("file:///".length).replace(/^\/([A-Za-z]:)/, "$1"));
  if (!existsSync(local)) {
    console.error(`tarball missing for ${entry.version}: ${local}`);
    process.exit(1);
  }
  const actual = sha256(local);
  if (actual !== entry.sha256) {
    console.error(`sha256 mismatch for ${entry.version}: manifest ${entry.sha256} actual ${actual}`);
    process.exit(1);
  }
  const remoteFile = `${REMOTE_DIR}/${basename(local)}`;
  console.log(`uploading ${basename(local)} (${(entry.sizeBytes / 1e6).toFixed(0)} MB, sha256 verified)…`);
  scp(local, remoteFile);
  entry.url = `https://${DOMAIN}/updates/${basename(local)}`;
  console.log(`  → ${entry.url}`);
}

// Write the hosted manifest atomically (tmp + rename), then verify it reads back.
const staged = `/tmp/engines.manifest.${randomBytes(4).toString("hex")}.json`;
const hosted = { ...manifest, publishedAt: new Date().toISOString() };
const put = (dest) =>
  ssh(`cat > ${dest} <<'EOF_MANIFEST'\n${JSON.stringify(hosted, null, 2)}\nEOF_MANIFEST`);
put(staged);
ssh(`mv ${staged} ${REMOTE_DIR}/engines.manifest.json`);
const remote = JSON.parse(ssh(`cat ${REMOTE_DIR}/engines.manifest.json`));
if (remote.engines.length !== hosted.engines.length) {
  console.error("remote manifest verification failed");
  process.exit(1);
}
console.log(`\ndone: ${entries.length} engine(s) published; hosted manifest live at https://${DOMAIN}/engines.manifest.json`);
console.log(`clients see it after Settings → Engine → Update server URL = https://${DOMAIN}/`);
