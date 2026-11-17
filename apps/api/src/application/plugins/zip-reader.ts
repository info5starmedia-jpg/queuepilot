import zlib from "node:zlib";

/**
 * Minimal, defensive ZIP reader for plugin imports (B3). Reads the central
 * directory only (the authoritative listing), supports stored (0) and
 * deflate (8) entries, and refuses everything else: encryption, ZIP64,
 * multi-disk archives, symlinks, unsafe names, and archives that would
 * expand past the caller's limits. No third-party code; ~one screen.
 *
 * Names are validated here, before anything touches the disk: a name may not
 * be absolute (/x, \x, C:x), may not contain a ".." segment, NUL or a
 * backslash-separated escape, and the caller still re-checks that the joined
 * path stays inside its target directory (defence in depth against zip-slip).
 */

export interface ZipEntry {
  /** Normalised forward-slash relative path; directories end with "/". */
  name: string;
  isDirectory: boolean;
  data: Buffer;
}

export interface ZipLimits {
  maxEntries: number;
  maxTotalBytes: number;
}

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

export class ZipRejected extends Error {}

/** Validate one archive member name. Returns the normalised name or throws. */
export function safeZipName(raw: string): string {
  if (raw.length === 0 || raw.length > 512) throw new ZipRejected("empty or overlong entry name");
  if (raw.includes("\0")) throw new ZipRejected(`entry name contains NUL`);
  const name = raw.replace(/\\/g, "/");
  if (name.startsWith("/") || /^[a-zA-Z]:/.test(name)) throw new ZipRejected(`absolute path rejected: ${raw}`);
  // Windows: ':' opens an NTFS alternate data stream ("index.mjs:x" writes a
  // hidden stream on index.mjs), and these characters are invalid anyway.
  if (/[:<>"|?*\x01-\x1f]/.test(name)) throw new ZipRejected(`character not allowed in a file name: ${raw}`);
  const parts = name.split("/");
  for (const [i, seg] of parts.entries()) {
    if (seg === "..") throw new ZipRejected(`path traversal rejected: ${raw}`);
    if (seg === "" && i !== parts.length - 1) throw new ZipRejected(`empty path segment rejected: ${raw}`);
    if (seg === ".") throw new ZipRejected(`"." segment rejected: ${raw}`);
    if (seg === "") continue;
    // Windows strips trailing dots/spaces ("index.mjs." IS index.mjs) and
    // maps device names (CON, NUL, COM1, ...) to devices, not files.
    if (/[. ]$/.test(seg)) throw new ZipRejected(`name ending in "." or space rejected: ${raw}`);
    if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i.test(seg)) throw new ZipRejected(`reserved device name rejected: ${raw}`);
  }
  return name;
}

export function readZip(buf: Buffer, limits: ZipLimits): ZipEntry[] {
  // End of central directory: last 22..(22+65535) bytes.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipRejected("not a zip archive (no end-of-central-directory record)");
  const disk = buf.readUInt16LE(eocd + 4);
  const cdDisk = buf.readUInt16LE(eocd + 6);
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (disk !== 0 || cdDisk !== 0) throw new ZipRejected("multi-disk archives are not supported");
  if (count === 0xffff || cdOffset === 0xffffffff) throw new ZipRejected("ZIP64 archives are not supported");
  if (count > limits.maxEntries) throw new ZipRejected(`too many entries (${count} > ${limits.maxEntries})`);
  if (cdOffset + cdSize > eocd) throw new ZipRejected("corrupt central directory");

  const entries: ZipEntry[] = [];
  const seen = new Set<string>();
  let total = 0;
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN_SIG) throw new ZipRejected("corrupt central directory entry");
    const madeBy = buf.readUInt16LE(p + 4) >> 8;
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const extAttr = buf.readUInt32LE(p + 38);
    const locOffset = buf.readUInt32LE(p + 42);
    const rawName = buf.subarray(p + 46, p + 46 + nameLen).toString(flags & 0x800 ? "utf8" : "latin1");
    p += 46 + nameLen + extraLen + commentLen;

    const name = safeZipName(rawName);
    if (flags & 0x1) throw new ZipRejected(`encrypted entry rejected: ${name}`);
    // Unix host (3): the high 16 bits are st_mode. Refuse symlinks and any
    // other non-regular, non-directory node.
    if (madeBy === 3) {
      const type = (extAttr >>> 16) & 0o170000;
      if (type !== 0 && type !== 0o100000 && type !== 0o040000) throw new ZipRejected(`symlink or special file rejected: ${name}`);
    }
    const key = name.toLowerCase();
    if (seen.has(key)) throw new ZipRejected(`duplicate entry rejected: ${name}`);
    seen.add(key);

    const isDirectory = name.endsWith("/");
    if (isDirectory) {
      entries.push({ name, isDirectory, data: Buffer.alloc(0) });
      continue;
    }
    total += size;
    if (total > limits.maxTotalBytes) throw new ZipRejected(`archive expands past ${limits.maxTotalBytes} bytes`);

    if (locOffset + 30 > buf.length || buf.readUInt32LE(locOffset) !== LOC_SIG) throw new ZipRejected(`corrupt local header: ${name}`);
    const dataStart = locOffset + 30 + buf.readUInt16LE(locOffset + 26) + buf.readUInt16LE(locOffset + 28);
    if (dataStart + compSize > buf.length) throw new ZipRejected(`truncated entry: ${name}`);
    const raw = buf.subarray(dataStart, dataStart + compSize);
    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) {
      // maxOutputLength bounds a lying size field (zip bomb) at the declared size.
      data = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(size, 1) });
    } else throw new ZipRejected(`unsupported compression method ${method}: ${name}`);
    if (data.length !== size) throw new ZipRejected(`size mismatch: ${name}`);
    if ((zlib.crc32(data) >>> 0) !== crc) throw new ZipRejected(`checksum mismatch: ${name}`);
    entries.push({ name, isDirectory, data });
  }
  return entries;
}
