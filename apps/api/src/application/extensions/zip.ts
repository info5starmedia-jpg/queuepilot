import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";

/**
 * Minimal ZIP extractor — just enough for extension packages (stored and
 * deflated entries), zero dependencies. Reads the end-of-central-directory
 * record, walks central entries, and inflates into a target directory.
 *
 * Deliberate limits, stated for the audit: no ZIP64 (extensions packages are
 * far below 4 GiB), no encryption, no multi-disk, symlinks materialize as
 * regular files' contents are never executed by us — Chromium reads them.
 */

export function unzipTo(zip: Buffer, targetDir: string): string[] {
  const eocd = findEocd(zip);
  const entryCount = zip.readUInt16LE(eocd + 10);
  let offset = zip.readUInt32LE(eocd + 16);
  const written: string[] = [];
  for (let i = 0; i < entryCount; i++) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error(`bad central directory signature at ${offset}`);
    }
    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const nameLen = zip.readUInt16LE(offset + 28);
    const extraLen = zip.readUInt16LE(offset + 30);
    const commentLen = zip.readUInt16LE(offset + 32);
    const localOffset = zip.readUInt32LE(offset + 42);
    const name = zip.subarray(offset + 46, offset + 46 + nameLen).toString("utf8");
    offset += 46 + nameLen + extraLen + commentLen;

    // Directories and anything outside the package root are skipped.
    if (name.endsWith("/")) continue;
    // Finder zips carry a __MACOSX metadata twin of every entry; it has no
    // business in an extension install (Fury issue-28 behavior).
    if (name.startsWith("__MACOSX/") || name.includes("/__MACOSX/")) continue;
    const rel = safeJoin(targetDir, name);
    if (rel === null) continue; // zip-slip attempt — never written

    const data = inflateEntry(zip, localOffset, compressedSize, method);
    fs.mkdirSync(path.dirname(rel), { recursive: true });
    fs.writeFileSync(rel, data);
    written.push(name);
  }
  return written;
}

/** Map a zip entry name to a safe absolute path, or null if it escapes. */
function safeJoin(root: string, name: string): string | null {
  const normalized = path.posix.normalize(name.replace(/\\/g, "/"));
  if (normalized.startsWith("/") || normalized.startsWith("..")) return null;
  return path.join(root, ...normalized.split("/"));
}

function inflateEntry(
  zip: Buffer,
  localOffset: number,
  compressedSize: number,
  method: number,
): Buffer {
  if (zip.readUInt32LE(localOffset) !== 0x04034b50) {
    throw new Error(`bad local header at ${localOffset}`);
  }
  const nameLen = zip.readUInt16LE(localOffset + 26);
  const extraLen = zip.readUInt16LE(localOffset + 28);
  const dataStart = localOffset + 30 + nameLen + extraLen;
  const data = zip.subarray(dataStart, dataStart + compressedSize);
  if (method === 0) return Buffer.from(data);
  if (method === 8) return zlib.inflateRawSync(data);
  throw new Error(`unsupported zip compression method ${method}`);
}

function findEocd(zip: Buffer): number {
  // EOCD signature 0x06054b50, max comment 65535.
  const min = Math.max(0, zip.length - 22 - 65535);
  for (let i = zip.length - 22; i >= min; i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new Error("not a zip file (end-of-central-directory not found)");
}

/**
 * Strip a CRX3 container down to its ZIP payload. Layout: magic "Cr24",
 * version uint32 (3), header_size uint32, header (protobuf), then the zip.
 * We do not parse the protobuf — the signature header is not needed to
 * install; Chromium re-verifies nothing for sideloaded unpacked installs.
 */
export function crxToZip(crx: Buffer): Buffer {
  if (crx.length < 12 || crx.toString("latin1", 0, 4) !== "Cr24") {
    throw new Error("not a CRX file (bad magic)");
  }
  const version = crx.readUInt32LE(4);
  if (version !== 3) {
    throw new Error(`unsupported CRX version ${version} (expected 3)`);
  }
  const headerSize = crx.readUInt32LE(8);
  const zipStart = 12 + headerSize;
  if (zipStart >= crx.length) {
    throw new Error("CRX header overruns the file");
  }
  return crx.subarray(zipStart);
}
