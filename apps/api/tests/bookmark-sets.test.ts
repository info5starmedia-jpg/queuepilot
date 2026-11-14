import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ErrorCodes } from "@queuepilot/contracts";
import {
  applyBookmarkSets,
  normalizeBookmarkSets,
} from "../src/application/runtime/bookmark-sets.js";
import { startUrlsOf } from "../src/application/runtime/fury-core.runtime.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "qp-bookmarks-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const SETS = [
  {
    id: "work",
    name: "Work",
    links: [
      { name: "Mail", url: "https://mail.example.com/" },
      { name: "Docs", url: "https://docs.example.com/" },
    ],
  },
  {
    id: "fun",
    name: "Fun",
    links: [{ name: "News", url: "https://news.example.com/" }],
  },
];

function readBookmarks(): {
  roots: { bookmark_bar: { children: { name?: string; url?: string; meta_info?: Record<string, string>; children?: unknown[] }[] } };
  checksum?: string;
} {
  return JSON.parse(fs.readFileSync(path.join(dir, "Default", "Bookmarks"), "utf8"));
}

describe("normalizeBookmarkSets", () => {
  it("accepts a well-formed bag and assigns positional ids when missing", () => {
    const sets = normalizeBookmarkSets([
      { name: "A", links: [{ name: "x", url: "https://x.example/" }] },
      { id: "b", name: "B", links: [] },
    ]);
    expect(sets[0]).toMatchObject({ id: "set-0", name: "A" });
    expect(sets[1]).toMatchObject({ id: "b", name: "B", links: [] });
    expect(normalizeBookmarkSets(undefined)).toEqual([]);
    expect(normalizeBookmarkSets("nope")).toEqual([]);
  });

  it("rejects duplicate ids, bad urls, and non-http schemes loudly", () => {
    expect(() =>
      normalizeBookmarkSets([{ id: "x", name: "a", links: [] }, { id: "x", name: "b", links: [] }]),
    ).toThrowError(expect.objectContaining({ code: ErrorCodes.VALIDATION_FAILED }));
    expect(() =>
      normalizeBookmarkSets([{ name: "a", links: [{ url: "not a url" }] }]),
    ).toThrowError(/invalid URL/);
    expect(() =>
      normalizeBookmarkSets([{ name: "a", links: [{ url: "file:///etc/passwd" }] }]),
    ).toThrowError(/http\/https/);
    expect(() => normalizeBookmarkSets([{ name: "" }])).toThrowError(/needs a name/);
  });
});

describe("applyBookmarkSets", () => {
  it("creates a Chromium-shaped Bookmarks file with sets at the bar front", () => {
    applyBookmarkSets(dir, normalizeBookmarkSets(SETS));
    const bm = readBookmarks();
    const bar = bm.roots.bookmark_bar.children;
    expect(bar.map((n) => n.name)).toEqual(["Work", "Fun"]);
    expect(bar[0]!.children).toHaveLength(2);
    expect(bar[0]!.meta_info).toEqual({ qp_set_id: "work" });
    expect(bar[0]!.children![0]).toMatchObject({ name: "Mail", url: "https://mail.example.com/" });
    expect(bm.checksum).toBeUndefined();
  });

  it("re-launch replaces managed folders, never duplicates; unmanaged bookmarks survive", () => {
    applyBookmarkSets(dir, normalizeBookmarkSets(SETS));
    // A bookmark the browser made itself (no marker) — must survive verbatim.
    const bmPath = path.join(dir, "Default", "Bookmarks");
    const doc = JSON.parse(fs.readFileSync(bmPath, "utf8"));
    doc.roots.bookmark_bar.children.push({
      type: "url",
      id: "7",
      name: "Mine",
      url: "https://mine.example/",
    });
    fs.writeFileSync(bmPath, JSON.stringify(doc));

    // Second launch with a CHANGED set list: "fun" gone, "work" updated.
    applyBookmarkSets(
      dir,
      normalizeBookmarkSets([
        {
          id: "work",
          name: "Work",
          links: [{ name: "Only", url: "https://only.example/" }],
        },
      ]),
    );
    const bm = readBookmarks();
    const bar = bm.roots.bookmark_bar.children;
    expect(bar.map((n) => n.name)).toEqual(["Work", "Mine"]);
    expect(bar[0]!.children).toHaveLength(1);
    expect(bar[1]).toMatchObject({ name: "Mine", url: "https://mine.example/" });
  });

  it("recovers from a malformed existing Bookmarks file", () => {
    fs.mkdirSync(path.join(dir, "Default"), { recursive: true });
    fs.writeFileSync(path.join(dir, "Default", "Bookmarks"), "{not json");
    applyBookmarkSets(dir, normalizeBookmarkSets(SETS));
    expect(readBookmarks().roots.bookmark_bar.children).toHaveLength(2);
  });

  it("is a no-op for an empty set list (never creates the file)", () => {
    applyBookmarkSets(dir, []);
    expect(fs.existsSync(path.join(dir, "Default", "Bookmarks"))).toBe(false);
  });
});

describe("startUrlsOf", () => {
  it("prefers startUrls[], falls back to the Jancy url column, defaults about:blank", () => {
    expect(
      startUrlsOf({ extra: { startUrls: ["https://a.example/", "https://b.example/"] } }),
    ).toEqual(["https://a.example/", "https://b.example/"]);
    expect(startUrlsOf({ extra: { url: " https://jancy.example/ " } })).toEqual([
      "https://jancy.example/",
    ]);
    expect(startUrlsOf({ extra: {} })).toEqual(["about:blank"]);
    expect(startUrlsOf({ extra: null })).toEqual(["about:blank"]);
  });

  it("drops non-URL and non-http(s) entries — they never reach argv", () => {
    expect(
      startUrlsOf({
        extra: { startUrls: ["javascript:alert(1)", "file:///x", "https://ok.example/", 42] },
      }),
    ).toEqual(["https://ok.example/"]);
    expect(startUrlsOf({ extra: { startUrls: ["garbage"] } })).toEqual(["about:blank"]);
  });
});
