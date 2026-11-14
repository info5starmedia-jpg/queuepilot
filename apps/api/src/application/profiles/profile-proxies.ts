/**
 * Per-profile proxy lists — Jancy's proxies column. Provider import stores
 * the raw strings in `profile.extra.proxies`; this module is the typed read
 * layer: parse, current-selection math, and masked panel views.
 *
 * Entry syntax (Jancy conventions):
 *   "host:port"              → direct, no auth, default scheme http
 *   "host:port:user:pass"    → direct with auth (pass may contain ':')
 *   "scheme://host:port:..." → explicit scheme (http | socks5)
 *   "system connection"      → the magic value: direct, no proxy at all
 *
 * `extra.proxyIndex` (integer, default 0) selects the current entry, modulo
 * the list length — same cycling discipline as SMS numbers.
 */

export type ProxyScheme = "http" | "socks5";

export type ProfileProxyEntry =
  | { kind: "system"; raw: string }
  | {
      kind: "direct";
      raw: string;
      scheme: ProxyScheme;
      host: string;
      port: number;
      username: string | null;
      password: string | null;
    };

const SCHEMES: Record<string, ProxyScheme> = { http: "http", socks5: "socks5" };

/** Parse one raw entry; null when it cannot be understood. */
export function parseProxyEntry(raw: string): ProfileProxyEntry | null {
  const s = raw.trim();
  if (s.length === 0) return null;
  if (/^system connection$/i.test(s)) return { kind: "system", raw: s };

  let scheme: ProxyScheme = "http";
  let rest = s;
  const schemeMatch = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(rest);
  if (schemeMatch) {
    const parsed = SCHEMES[schemeMatch[1]!.toLowerCase()];
    if (!parsed) return null; // unknown scheme — refuse, don't guess
    scheme = parsed;
    rest = rest.slice(schemeMatch[0].length);
  }

  const parts = rest.split(":");
  if (parts.length < 2) return null;
  const host = parts[0]!.trim();
  const port = Number(parts[1]);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  const username = parts.length >= 3 && parts[2] !== undefined && parts[2] !== ""
    ? parts[2]!
    : null;
  // Password takes the remainder verbatim so secrets containing ':' survive.
  const password = parts.length >= 4 ? parts.slice(3).join(":") || null : null;
  return { kind: "direct", raw: s, scheme, host, port, username, password };
}

/** All parseable entries of the list, in order (unparseable raws are dropped). */
export function profileProxyEntries(extra: Record<string, unknown> | null): ProfileProxyEntry[] {
  const raw = (extra ?? {}).proxies;
  if (!Array.isArray(raw)) return [];
  const out: ProfileProxyEntry[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const parsed = parseProxyEntry(item);
    if (parsed) out.push(parsed);
  }
  return out;
}

function proxyIndexOf(extra: Record<string, unknown> | null): number {
  const raw = (extra ?? {}).proxyIndex;
  return typeof raw === "number" && Number.isFinite(raw) ? Math.trunc(raw) : 0;
}

/** Index of the current entry, modulo list length; null when the list is empty. */
export function currentProxyIndex(
  extra: Record<string, unknown> | null,
  total: number,
): number | null {
  if (total <= 0) return null;
  return ((proxyIndexOf(extra) % total) + total) % total;
}

/** Next persisted index for one rotation step. */
export function nextProxyIndex(extra: Record<string, unknown> | null): number {
  return proxyIndexOf(extra) + 1;
}

/**
 * The entry a launch would use right now: current index into the parseable
 * list. null when the list is empty; the caller decides whether that means
 * "no proxy" or an error.
 */
export function currentProfileProxy(
  extra: Record<string, unknown> | null,
): { index: number; total: number; entry: ProfileProxyEntry } | null {
  const entries = profileProxyEntries(extra);
  if (entries.length === 0) return null;
  const index = currentProxyIndex(extra, entries.length)!;
  return { index, total: entries.length, entry: entries[index]! };
}

/**
 * Panel-safe view: the password is never echoed; the username is kept (it
 * identifies which account the entry uses, and is not a secret).
 */
export type MaskedProxyEntry =
  | { kind: "system"; raw: string; hasPassword: false }
  | {
      kind: "direct";
      scheme: ProxyScheme;
      host: string;
      port: number;
      username: string | null;
      hasPassword: boolean;
    };

export function maskProxyEntry(entry: ProfileProxyEntry): MaskedProxyEntry {
  if (entry.kind === "system") return { kind: "system", raw: entry.raw, hasPassword: false };
  return {
    kind: "direct",
    scheme: entry.scheme,
    host: entry.host,
    port: entry.port,
    username: entry.username,
    hasPassword: entry.password !== null,
  };
}
