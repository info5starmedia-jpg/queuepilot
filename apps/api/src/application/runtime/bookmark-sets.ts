import fs from "node:fs";
import path from "node:path";
import { DomainError, ErrorCodes } from "@queuepilot/contracts";

/**
 * Bookmark sets — Fury 0.5.3's "named link folders deployed at launch"
 * feature, implemented at the runtime layer instead of C++ (our engine's
 * config schema carries no bookmark key, and rebuilding Chromium for a
 * file-format feature would be waste). We merge into Chromium's own
 * `Default/Bookmarks` JSON before launch:
 *
 *  - Every set becomes a folder at the FRONT of the bookmarks bar, tagged
 *    with `meta_info.qp_set_id` so we can find it again.
 *  - Re-launch replaces our folders (same set id) — never duplicates.
 *  - Browser-made bookmarks are never touched: anything without our
 *    marker survives verbatim, in order.
 *  - The "checksum" field is dropped; Chromium regenerates it.
 *
 * Sets come from `profile.extra.bookmarkSets`:
 *   [{ id?: string, name: string, links: [{ name: string, url: string }] }]
 */

export interface BookmarkSetLink {
  name: string;
  url: string;
}

export interface BookmarkSet {
  id: string;
  name: string;
  links: BookmarkSetLink[];
}

const META_KEY = "qp_set_id";

interface BookmarkNode {
  type?: string;
  id?: string;
  name?: string;
  url?: string;
  children?: BookmarkNode[];
  meta_info?: Record<string, string>;
  date_added?: string;
  date_last_used?: string;
  date_modified?: string;
  source?: string;
}

interface BookmarksFile {
  roots?: {
    bookmark_bar?: { children?: BookmarkNode[]; [k: string]: unknown };
    other?: { children?: BookmarkNode[]; [k: string]: unknown };
    synced?: { children?: BookmarkNode[]; [k: string]: unknown };
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

/** Shape of a set as accepted from profile.extra.bookmarkSets (loose input). */
export function normalizeBookmarkSets(raw: unknown): BookmarkSet[] {
  if (!Array.isArray(raw)) return [];
  const sets: BookmarkSet[] = [];
  const seen = new Set<string>();
  for (const [i, item] of raw.entries()) {
    if (!item || typeof item !== "object") {
      throw new DomainError(
        ErrorCodes.VALIDATION_FAILED,
        `bookmarkSets[${i}] must be an object {name, links}`,
      );
    }
    const s = item as { id?: unknown; name?: unknown; links?: unknown };
    if (typeof s.name !== "string" || s.name.trim() === "") {
      throw new DomainError(ErrorCodes.VALIDATION_FAILED, `bookmarkSets[${i}] needs a name`);
    }
    const id = typeof s.id === "string" && s.id.trim() !== "" ? s.id : `set-${i}`;
    if (seen.has(id)) {
      throw new DomainError(
        ErrorCodes.VALIDATION_FAILED,
        `duplicate bookmark set id "${id}"`,
      );
    }
    seen.add(id);
    if (!Array.isArray(s.links)) {
      throw new DomainError(
        ErrorCodes.VALIDATION_FAILED,
        `bookmark set "${s.name}" needs a links[] array`,
      );
    }
    const links: BookmarkSetLink[] = [];
    for (const [j, link] of s.links.entries()) {
      const l = link as { name?: unknown; url?: unknown };
      const url = typeof l?.url === "string" ? l.url.trim() : "";
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new DomainError(
          ErrorCodes.VALIDATION_FAILED,
          `bookmark set "${s.name}" link ${j} has an invalid URL: ${JSON.stringify(url.slice(0, 60))}`,
        );
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new DomainError(
          ErrorCodes.VALIDATION_FAILED,
          `bookmark set "${s.name}" link ${j} must be http/https (got ${parsed.protocol})`,
        );
      }
      links.push({
        name: typeof l?.name === "string" && l.name.trim() !== "" ? l.name : parsed.hostname,
        url,
      });
    }
    sets.push({ id, name: s.name.trim(), links });
  }
  return sets;
}

let nextNodeId = 100_000;

function folderNode(set: BookmarkSet): BookmarkNode {
  return {
    type: "folder",
    id: String(nextNodeId++),
    name: set.name,
    children: set.links.map((l) => ({
      type: "url",
      id: String(nextNodeId++),
      name: l.name,
      url: l.url,
      meta_info: { [META_KEY]: set.id },
    })),
    meta_info: { [META_KEY]: set.id },
    date_added: "0",
    date_last_used: "0",
    date_modified: "0",
  };
}

/**
 * Merge `sets` into `<profileDataDir>/Default/Bookmarks`. No-op when the
 * set list is empty. Existing managed folders with the same id are replaced;
 * unmanaged content is preserved byte-for-byte in structure.
 */
export function applyBookmarkSets(profileDataDir: string, sets: BookmarkSet[]): void {
  if (sets.length === 0) return;
  const defaultDir = path.join(profileDataDir, "Default");
  fs.mkdirSync(defaultDir, { recursive: true });
  const bookmarksPath = path.join(defaultDir, "Bookmarks");

  let doc: BookmarksFile;
  try {
    doc = JSON.parse(fs.readFileSync(bookmarksPath, "utf8")) as BookmarksFile;
    if (!doc.roots || typeof doc.roots !== "object") throw new Error("no roots");
  } catch {
    doc = {
      checksum: "",
      version: 1,
      roots: {
        bookmark_bar: { children: [], date_added: "0", date_modified: "0", id: "1", name: "Bookmarks bar", type: "folder" },
        other: { children: [], date_added: "0", date_modified: "0", id: "2", name: "Other bookmarks", type: "folder" },
        synced: { children: [], date_added: "0", date_modified: "0", id: "3", name: "Mobile bookmarks", type: "folder" },
      },
    };
  }

  // Both branches above guarantee roots (the try branch throws otherwise).
  const roots = doc.roots!;
  const bar = (roots.bookmark_bar ??= { children: [] });
  const children = bar.children ?? [];
  // Drop every folder we manage (anything carrying our marker — a set that
  // is no longer configured must disappear too), keep everything else
  // verbatim: browser-made bookmarks are never touched.
  const kept = children.filter((n) => n?.meta_info?.[META_KEY] === undefined);
  // Listed order is the bar order: the first set lands at the very front.
  bar.children = [...sets.map(folderNode), ...kept];

  // Chromium regenerates the checksum; a stale one is worse than none.
  delete doc.checksum;

  const tmp = `${bookmarksPath}.qp-tmp`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), "utf8");
  fs.renameSync(tmp, bookmarksPath);
}
