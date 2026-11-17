import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readZip, safeZipName, type ZipEntry } from "./zip-reader.js";

/**
 * Plugin import (B3): turn an uploaded script or zip into a plugin folder
 * under <dataDir>/plugins/<id>/ — DISABLED, never imported, until the owner
 * enables it. A single .mjs/.js becomes a minimal plugin (package.json
 * synthesised, entry renamed index.mjs so it always loads as ESM). A .zip
 * must hold one plugin folder (package.json at its root, or inside a single
 * top-level folder). Everything lands in a hidden staging folder first and
 * is renamed into place only when every file was written, so a rejected
 * archive leaves nothing behind.
 */

export const PLUGIN_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;
export const PLUGIN_ZIP_LIMITS = { maxEntries: 500, maxTotalBytes: 20 * 1024 * 1024 };

/** A rejection the caller reports per file; the message is the reason. */
export class PluginImportError extends Error {}

export interface InstalledPlugin {
  id: string;
  name: string;
}

/** Plugin ids are folder names: lowercase letters, digits, '-' and '_'. */
export function pluginIdFrom(raw: string): string {
  const id = raw
    .toLowerCase()
    .replace(/^@[^/]+\//, "") // npm scope
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  if (!id) throw new PluginImportError("cannot derive a plugin id from the name");
  return id;
}

export function installPluginFile(pluginsDir: string, filename: string, bytes: Buffer): InstalledPlugin {
  const base = path.basename(filename.replace(/\\/g, "/"));
  const ext = path.extname(base).toLowerCase();
  if (bytes.length === 0) throw new PluginImportError("file is empty");
  if (bytes.length > PLUGIN_UPLOAD_MAX_BYTES) throw new PluginImportError(`file is larger than ${PLUGIN_UPLOAD_MAX_BYTES} bytes`);

  let id: string;
  let name: string;
  let files: Array<{ name: string; data: Buffer }>;
  if (ext === ".mjs" || ext === ".js") {
    id = pluginIdFrom(base.slice(0, -ext.length));
    name = id;
    const manifest = { name: id, version: "0.0.0", main: "index.mjs", description: `Imported from ${base}` };
    files = [
      { name: "package.json", data: Buffer.from(JSON.stringify(manifest, null, 2)) },
      { name: "index.mjs", data: bytes },
    ];
  } else if (ext === ".zip") {
    ({ id, name, files } = fromZip(bytes));
  } else {
    throw new PluginImportError(`unsupported file type "${ext || base}" — upload a .mjs, .js or .zip`);
  }

  fs.mkdirSync(pluginsDir, { recursive: true });
  const target = path.join(pluginsDir, id);
  if (fs.existsSync(target)) throw new PluginImportError(`plugin "${id}" is already installed — remove its folder first`);

  const stage = path.join(pluginsDir, `.import-${randomUUID()}`);
  fs.mkdirSync(stage);
  try {
    const root = path.resolve(stage) + path.sep;
    for (const f of files) {
      const full = path.resolve(stage, f.name);
      // Defence in depth: names were validated, and the joined path must
      // still land inside the staging folder (zip-slip).
      if (!full.startsWith(root)) throw new PluginImportError(`path escapes the plugin folder: ${f.name}`);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, f.data, { flag: "wx" });
    }
    // Lands disabled no matter what the archive shipped.
    fs.writeFileSync(path.join(stage, "enabled.json"), JSON.stringify({ enabled: false }, null, 2));
    fs.renameSync(stage, target);
  } catch (err) {
    fs.rmSync(stage, { recursive: true, force: true });
    throw err instanceof PluginImportError ? err : new PluginImportError(err instanceof Error ? err.message : String(err));
  }
  return { id, name };
}

function fromZip(bytes: Buffer): { id: string; name: string; files: Array<{ name: string; data: Buffer }> } {
  let entries: ZipEntry[];
  try {
    entries = readZip(bytes, PLUGIN_ZIP_LIMITS);
  } catch (err) {
    throw new PluginImportError(err instanceof Error ? err.message : String(err));
  }
  let files = entries.filter((e) => !e.isDirectory);
  if (files.length === 0) throw new PluginImportError("archive contains no files");

  // One plugin folder: package.json at the root, or every file inside a
  // single top-level folder that holds it.
  if (!files.some((f) => f.name === "package.json")) {
    const tops = new Set(files.map((f) => f.name.split("/")[0]));
    const [top] = [...tops];
    if (tops.size !== 1 || !files.some((f) => f.name === `${top}/package.json`)) {
      throw new PluginImportError("archive must contain package.json at its root or inside one top-level folder");
    }
    files = files.map((f) => ({ ...f, name: f.name.slice(top!.length + 1) }));
  }
  // Our own state files are never taken from an upload.
  files = files.filter((f) => f.name !== "enabled.json" && f.name !== "store.json");

  let manifest: { name?: unknown; main?: unknown };
  try {
    manifest = JSON.parse(files.find((f) => f.name === "package.json")!.data.toString("utf8"));
  } catch {
    throw new PluginImportError("package.json is not valid JSON");
  }
  if (typeof manifest.name !== "string" || !manifest.name.trim()) throw new PluginImportError("package.json needs a \"name\"");
  const main = typeof manifest.main === "string" ? manifest.main : "index.mjs";
  let mainName: string;
  try {
    mainName = safeZipName(main.replace(/^\.\//, ""));
  } catch (err) {
    throw new PluginImportError(`package.json "main" is not a safe path: ${(err as Error).message}`);
  }
  if (!files.some((f) => f.name === mainName)) throw new PluginImportError(`entry file "${main}" is not in the archive`);
  return { id: pluginIdFrom(manifest.name), name: manifest.name, files: files.map((f) => ({ name: f.name, data: f.data })) };
}
