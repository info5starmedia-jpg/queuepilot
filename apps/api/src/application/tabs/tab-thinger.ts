import { DomainError, ErrorCodes, type BrowserTab } from "@queuepilot/contracts";

/**
 * Tab Thinger — Jancy's formula query language over tabs, minimal slice.
 *
 * A query is whitespace-separated tokens, ANDed together. Each token is
 * `[!]field:pattern`; a bare token without `:` is sugar for a url substring
 * match. `*` in a pattern matches anything (wildcard); without it, url
 * matches are substrings, partition matches are id prefixes, and
 * status/id matches are exact.
 *
 *   status:open              open tabs only
 *   url:*checkout*           url contains "checkout" (case-insensitive)
 *   !url:*example.com*       url does NOT contain example.com
 *   related:no               isolated partitions only
 *   engine:yes               tabs with an engine-side handle
 *   partition:<uuid-prefix>  partition id starts with the prefix
 *   checkout                 sugar for url:*checkout*
 *
 * Empty query = everything. Unknown fields refuse loudly (VALIDATION_FAILED)
 * — a typo'd query must never silently match everything.
 */

export type TabPredicate = (tab: BrowserTab) => boolean;

const FIELDS = ["status", "url", "id", "partition", "related", "engine"] as const;
type Field = (typeof FIELDS)[number];

function fieldOf(token: string): Field {
  const name = token.toLowerCase();
  if ((FIELDS as readonly string[]).includes(name)) return name as Field;
  throw new DomainError(
    ErrorCodes.VALIDATION_FAILED,
    `unknown tab query field "${token}" — valid fields: ${FIELDS.join(", ")}`,
  );
}

/** `*` → any-substring regex; everything else literal. Case-insensitive. */
function wildcardRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, (c) => (c === "*" ? ".*" : `\\${c}`));
  return new RegExp(escaped, "i");
}

function valueOf(tab: BrowserTab, field: Field): string {
  switch (field) {
    case "status":
      return tab.status;
    case "url":
      return tab.url ?? "";
    case "id":
      return tab.id;
    case "partition":
      return tab.partitionId;
    case "related":
      return tab.relatedToTabId ? "yes" : "no";
    case "engine":
      return tab.engineTabId ? "yes" : "no";
  }
}

/** Compile a query string into a predicate. Throws on unknown fields. */
export function compileTabQuery(query: string): TabPredicate {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  const clauses: { field: Field; pattern: string; negate: boolean; bare: boolean }[] = [];
  for (const raw of tokens) {
    let token = raw;
    let negate = false;
    if (token.startsWith("!")) {
      negate = true;
      token = token.slice(1);
    }
    const colon = token.indexOf(":");
    if (colon < 0) {
      // Bare token: url substring sugar.
      clauses.push({ field: "url", pattern: token, negate, bare: true });
      continue;
    }
    const field = fieldOf(token.slice(0, colon));
    const pattern = token.slice(colon + 1);
    if (!pattern) {
      throw new DomainError(
        ErrorCodes.VALIDATION_FAILED,
        `tab query token "${raw}" has an empty pattern`,
      );
    }
    clauses.push({ field, pattern, negate, bare: false });
  }

  return (tab) =>
    clauses.every(({ field, pattern, negate, bare }) => {
      const value = valueOf(tab, field);
      let hit: boolean;
      if (bare) {
        hit = value.toLowerCase().includes(pattern.toLowerCase());
      } else if (pattern.includes("*")) {
        hit = wildcardRegex(pattern).test(value);
      } else if (field === "url") {
        hit = value.toLowerCase().includes(pattern.toLowerCase());
      } else if (field === "partition") {
        // Prefix match — typing the first uuid segment is the use case.
        hit = value.toLowerCase().startsWith(pattern.toLowerCase());
      } else {
        hit = value.toLowerCase() === pattern.toLowerCase();
      }
      return negate ? !hit : hit;
    });
}

/** Filter tabs by a Thinger query. Empty query returns all tabs. */
export function filterTabs(tabs: BrowserTab[], query: string): BrowserTab[] {
  const pred = compileTabQuery(query);
  return tabs.filter(pred);
}

/**
 * Tab sort modes — the console's 7-mode ambition narrowed to the six orderings
 * real tab records can honor (no page-title tracking in the API). Pure
 * function over a copy; unknown modes refuse rather than silently pass
 * through.
 */
export const TAB_SORT_MODES = [
  "newest",
  "oldest",
  "url",
  "domain",
  "status",
  "partition",
] as const;
export type TabSortMode = (typeof TAB_SORT_MODES)[number];

export function isTabSortMode(mode: string): mode is TabSortMode {
  return (TAB_SORT_MODES as readonly string[]).includes(mode);
}

function domainOf(url: string | null): string {
  if (!url) return "";
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/** Return a sorted COPY of the tabs; ties keep input order (stable). */
export function sortTabs(tabs: BrowserTab[], mode: TabSortMode): BrowserTab[] {
  const by = (key: (t: BrowserTab) => string): BrowserTab[] =>
    [...tabs].sort((a, b) => key(a).localeCompare(key(b)) || tabs.indexOf(a) - tabs.indexOf(b));
  switch (mode) {
    case "newest":
      return [...tabs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    case "oldest":
      return [...tabs].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    case "url":
      return by((t) => (t.url ?? "").toLowerCase());
    case "domain":
      // Domain ties fall through to the full URL — deterministic order.
      return by((t) => `${domainOf(t.url).toLowerCase()}${(t.url ?? "").toLowerCase()}`);
    case "status":
      return by((t) => t.status);
    case "partition":
      return by((t) => t.partitionId);
  }
}
