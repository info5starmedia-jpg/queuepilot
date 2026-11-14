import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { ExtensionRegistry } from "../src/application/extensions/extension-registry.js";
import { pinnedExtensionKey, extensionIdFromSpki } from "../src/application/extensions/extension-id.js";
import { unzipTo, crxToZip } from "../src/application/extensions/zip.js";
import { MapSecretStore } from "./helpers.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "qp-ext-test-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** Build a minimal single-file zip (stored or deflated) for fixtures. */
function buildZip(entries: Record<string, string | Buffer>, deflate = false): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, contentRaw] of Object.entries(entries)) {
    const content = Buffer.isBuffer(contentRaw) ? contentRaw : Buffer.from(contentRaw, "utf8");
    const nameBuf = Buffer.from(name, "utf8");
    const data = deflate ? zlib.deflateRawSync(content) : content;
    const method = deflate ? 8 : 0;
    const crc = crc32(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, nameBuf]));
    offset += 30 + nameBuf.length + data.length;
  }
  const centralBlob = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(entries).length, 8);
  eocd.writeUInt16LE(Object.keys(entries).length, 10);
  eocd.writeUInt32LE(centralBlob.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBlob, eocd]);
}

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function manifestZip(name: string, version = "1.0.0", extra: Record<string, string> = {}): Buffer {
  return buildZip({
    "manifest.json": JSON.stringify({ manifest_version: 3, name, version }),
    "content.js": `// ${name}`,
    ...extra,
  });
}

function crx3(zip: Buffer): Buffer {
  const header = Buffer.from("fake-protobuf-header");
  const out = Buffer.alloc(12);
  out.write("Cr24", 0, "latin1");
  out.writeUInt32LE(3, 4);
  out.writeUInt32LE(header.length, 8);
  return Buffer.concat([out, header, zip]);
}

describe("extension ids", () => {
  it("pinned id is stable per name across instances and SecretStores are the pinning store", () => {
    const secrets = new MapSecretStore();
    const a = pinnedExtensionKey(secrets, "AdBlock");
    const b = pinnedExtensionKey(secrets, "AdBlock");
    const c = pinnedExtensionKey(secrets, "Other");
    expect(a.id).toBe(b.id);
    expect(a.id).toMatch(/^[a-p]{32}$/);
    expect(c.id).not.toBe(a.id);
    // a fresh store mints a different id for the same name (machine-local)
    const d = pinnedExtensionKey(new MapSecretStore(), "AdBlock");
    expect(d.id).not.toBe(a.id);
  });

  it("extensionIdFromSpki matches the known Chrome test-vector shape (32 a-p chars, deterministic)", () => {
    const secrets = new MapSecretStore();
    const k1 = pinnedExtensionKey(secrets, "X");
    const k2 = pinnedExtensionKey(new MapSecretStore(), "X");
    expect(extensionIdFromSpki(k1.publicKeySpkiDer)).toBe(k1.id);
    expect(k1.id).not.toBe(k2.id);
  });
});

describe("zip / crx", () => {
  it("unzipTo extracts stored and deflated entries", () => {
    const zip = buildZip({ "a/b.txt": "hello", "c.txt": "world" }, true);
    const out = path.join(dir, "unzipped");
    const written = unzipTo(zip, out);
    expect(written.sort()).toEqual(["a/b.txt", "c.txt"]);
    expect(fs.readFileSync(path.join(out, "a/b.txt"), "utf8")).toBe("hello");
  });

  it("zip-slip entries are skipped, never written", () => {
    const zip = buildZip({ "../evil.txt": "bad", "ok.txt": "fine" });
    const out = path.join(dir, "slip");
    unzipTo(zip, out);
    expect(fs.existsSync(path.join(dir, "evil.txt"))).toBe(false);
    expect(fs.existsSync(path.join(out, "ok.txt"))).toBe(true);
  });

  it("crxToZip strips the CRX3 container; bad magic is rejected", () => {
    const zip = manifestZip("Z");
    const roundTrip = unzipTo(crxToZip(crx3(zip)), path.join(dir, "crx"));
    expect(roundTrip).toContain("manifest.json");
    expect(() => crxToZip(Buffer.from("not a crx"))).toThrow(/magic/);
  });
});

describe("ExtensionRegistry", () => {
  function make() {
    return new ExtensionRegistry(dir, new MapSecretStore());
  }
  function profileDir(id: string): string {
    return path.join(dir, "profiles", id);
  }

  it("installs from an unpacked folder, lists, and re-installs idempotently by name", () => {
    const src = path.join(dir, "src-ext");
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "FolderExt", version: "2.1.0" }));
    const reg = make();
    const e1 = reg.install("p1", src);
    expect(e1).toMatchObject({ name: "FolderExt", version: "2.1.0" });
    expect(e1.id).toMatch(/^[a-p]{32}$/);
    expect(fs.existsSync(path.join(profileDir("p1"), "Default", "Extensions", e1.id, "2.1.0", "manifest.json"))).toBe(true);

    const e2 = reg.install("p2", src);
    expect(e2.id).toBe(e1.id); // pinned across profiles
    expect(reg.list("p1")).toHaveLength(1);

    // upgraded version replaces, id survives
    fs.writeFileSync(path.join(src, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "FolderExt", version: "2.2.0" }));
    const e3 = reg.install("p1", src);
    expect(e3.id).toBe(e1.id);
    expect(e3.version).toBe("2.2.0");
    expect(reg.list("p1")).toHaveLength(1);
  });

  it("installs from .zip and .crx", () => {
    const zipPath = path.join(dir, "z.zip");
    fs.writeFileSync(zipPath, manifestZip("ZipExt", "1.2.3"));
    const crxPath = path.join(dir, "c.crx");
    fs.writeFileSync(crxPath, crx3(manifestZip("CrxExt", "3.2.1")));
    const reg = make();
    expect(reg.install("p1", zipPath).name).toBe("ZipExt");
    expect(reg.install("p1", crxPath).name).toBe("CrxExt");
    expect(reg.list("p1")).toHaveLength(2);
  });

  it("rejects packages without a manifest", () => {
    const bad = path.join(dir, "bad.zip");
    fs.writeFileSync(bad, buildZip({ "readme.txt": "hi" }));
    const reg = make();
    expect(() => reg.install("p1", bad)).toThrow(/manifest/);
  });

  it("copyFrom copies the install dir WITHOUT the source profile's storage", () => {
    const src = path.join(dir, "src-ext");
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "CopyExt", version: "1.0.0" }));
    const reg = make();
    const installed = reg.install("p1", src);
    // simulate browser-made storage for the extension on the source profile
    const storageDir = path.join(profileDir("p1"), "Default", "Local Extension Settings", installed.id);
    fs.mkdirSync(path.join(storageDir, "leveldb"), { recursive: true });
    fs.writeFileSync(path.join(storageDir, "leveldb", "CURRENT"), "storage-marker");

    const copy = reg.copyFrom("p2", "p1", installed.id);
    expect(copy.id).toBe(installed.id);
    expect(copy.source).toBe("copy:p1");
    const p2Code = path.join(profileDir("p2"), "Default", "Extensions", installed.id, "1.0.0", "manifest.json");
    expect(fs.existsSync(p2Code)).toBe(true);
    // storage must NOT have travelled
    expect(fs.existsSync(path.join(profileDir("p2"), "Default", "Local Extension Settings", installed.id))).toBe(false);
  });

  it("remove deletes code AND the profile's storage for it", () => {
    const src = path.join(dir, "src-ext");
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "RmvExt", version: "1.0.0" }));
    const reg = make();
    const installed = reg.install("p1", src);
    const storageDir = path.join(profileDir("p1"), "Default", "Local Extension Settings", installed.id);
    fs.mkdirSync(storageDir, { recursive: true });

    expect(reg.remove("p1", installed.id)).toBe(true);
    expect(reg.list("p1")).toHaveLength(0);
    expect(fs.existsSync(path.join(profileDir("p1"), "Default", "Extensions", installed.id))).toBe(false);
    expect(fs.existsSync(storageDir)).toBe(false);
    expect(reg.remove("p1", installed.id)).toBe(false);
  });
});
