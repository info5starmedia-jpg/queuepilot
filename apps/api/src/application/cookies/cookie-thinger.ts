import { CdpConnection } from "../runtime/cdp/cdp-connection.js";
import { attachPageSession } from "../runtime/cdp/cdp-page-session.js";

/**
 * Cookie Thinger — programmable cookie surgery over CDP.
 *
 * Local-first like everything else: the operator's own browser, the
 * operator's own data — values are listed, set and cleared on request.
 *
 * - List: `Network.getAllCookies` (every partition) or per-partition via
 *   `Network.getCookies { browserContextId }` (Chrome 115+). Domain/name
 *   filters accept `*` wildcards, case-insensitive (`*.example.com`).
 * - Set: browser-level `Network.setCookie` for the default store; when a
 *   partition is named, the set happens through a live page in that
 *   partition so the cookie lands in the partition's own store.
 * - Clear: list-then-delete — `Network.deleteCookies` per matched cookie,
 *   scoped the same way as the list that found it.
 *
 * Partition resolution: the tab registry's open tabs carry
 * partitionId + engineTabId; Target.getTargets maps engineTabId →
 * browserContextId. No runtime-port changes needed.
 */

export interface CookieRecord {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  secure: boolean;
  httpOnly: boolean;
  /** Engine-side browser context when known (partition-isolated stores). */
  browserContextId: string | null;
}

export interface CookieFilter {
  /** Domain pattern; `*` wildcard, case-insensitive. `.example.com` also
   *  matches `example.com` (Chromium's leading-dot domain form). */
  domain?: string | undefined;
  /** Name pattern; `*` wildcard, case-insensitive. */
  name?: string | undefined;
}

export interface SetCookieInput {
  name: string;
  value: string;
  domain: string;
  path?: string | undefined;
  expires?: number | undefined;
  secure?: boolean | undefined;
  httpOnly?: boolean | undefined;
}

function patternRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, (c) => (c === "*" ? ".*" : `\\${c}`));
  return new RegExp(`^${escaped}$`, "i");
}

function matches(cookie: CookieRecord, filter: CookieFilter): boolean {
  if (filter.name && !patternRegex(filter.name).test(cookie.name)) return false;
  if (filter.domain) {
    const want = filter.domain.replace(/^\./, "");
    const bare = cookie.domain.replace(/^\./, "");
    if (!(patternRegex(want).test(bare) || patternRegex(filter.domain).test(cookie.domain))) {
      return false;
    }
  }
  return true;
}

interface TargetInfo {
  targetId: string;
  type: string;
  browserContextId?: string;
}

/**
 * browserContextIds backing the given engine tab ids (from the tab
 * registry), discovered over the browser-level connection.
 */
async function contextsForTabs(
  conn: CdpConnection,
  engineTabIds: Set<string>,
): Promise<Set<string>> {
  const r = await conn.call<{ targetInfos?: TargetInfo[] }>("Target.getTargets", {}, 10_000);
  const out = new Set<string>();
  for (const t of r.targetInfos ?? []) {
    if (t.type === "page" && engineTabIds.has(t.targetId) && t.browserContextId) {
      out.add(t.browserContextId);
    }
  }
  return out;
}

/**
 * Every cookie visible to a page session. `Network.getAllCookies` /
 * `Network.getCookies` are page-domain methods — the browser-level socket
 * rejects them ("wasn't found") — so this attaches to the first open page
 * (or a transient `about:blank` only when the browser has no page at all)
 * and issues the call on that session. `browserContextId: null` marks the
 * store attribution as unknown at this layer; partition attribution comes
 * from which tab's context answered.
 */
async function listViaPageSession(
  conn: CdpConnection,
  method: "Network.getAllCookies" | "Network.getCookies",
): Promise<CookieRecord[]> {
  const session = await attachPageSession(conn);
  try {
    const r = await conn.call<{ cookies: CookieRecord[] }>(method, {}, 15_000, session.sessionId);
    return (r.cookies ?? []).map((c) => ({ ...c, browserContextId: null }));
  } finally {
    await session.release();
  }
}

/** Every cookie in the run (all partitions), with context attribution. */
export async function listAllCookies(wsEndpoint: string): Promise<CookieRecord[]> {
  const conn = await CdpConnection.connect(wsEndpoint, 10_000);
  try {
    return await listViaPageSession(conn, "Network.getAllCookies");
  } finally {
    conn.close();
  }
}

/**
 * Cookies of specific browser contexts (partitions). `Network.getCookies`
 * is a page-domain method, so it goes out on one page session (attached to
 * a partition tab when there is one); the `browserContextId` param scopes
 * each call to its context, so a single session can read every partition.
 */
async function listContextCookies(
  conn: CdpConnection,
  engineTabIds: Set<string>,
): Promise<CookieRecord[]> {
  const browserContextIds = await contextsForTabs(conn, engineTabIds);
  const preferTargetId = [...engineTabIds][0];
  const session = await attachPageSession(conn, preferTargetId ? { preferTargetId } : {});
  try {
    const out: CookieRecord[] = [];
    for (const browserContextId of browserContextIds) {
      const r = await conn.call<{ cookies: CookieRecord[] }>(
        "Network.getCookies",
        { browserContextId },
        15_000,
        session.sessionId,
      );
      for (const c of r.cookies ?? []) out.push({ ...c, browserContextId });
    }
    return out;
  } finally {
    await session.release();
  }
}

export interface ListCookiesOptions {
  /** Engine tab ids (partition members) to scope the list to. */
  engineTabIds?: Set<string> | undefined;
}

export async function listCookies(
  wsEndpoint: string,
  filter: CookieFilter = {},
  opts: ListCookiesOptions = {},
): Promise<CookieRecord[]> {
  const conn = await CdpConnection.connect(wsEndpoint, 10_000);
  try {
    const cookies =
      opts.engineTabIds && opts.engineTabIds.size > 0
        ? await listContextCookies(conn, opts.engineTabIds)
        : await listViaPageSession(conn, "Network.getAllCookies");
    return cookies.filter((c) => matches(c, filter));
  } finally {
    conn.close();
  }
}

/** Set one cookie (default store, or a partition via a live page there). */
export async function setCookie(
  wsEndpoint: string,
  input: SetCookieInput,
  opts: { engineTabId?: string | undefined } = {},
): Promise<void> {
  const params = {
    name: input.name,
    value: input.value,
    domain: input.domain,
    path: input.path ?? "/",
    secure: input.secure ?? false,
    httpOnly: input.httpOnly ?? false,
    ...(input.expires ? { expires: input.expires } : {}),
  };
  const conn = await CdpConnection.connect(wsEndpoint, 10_000);
  try {
    // `Network.setCookie` is a page-domain method: always send it on a
    // session attached to a page — the partition's page when known, else
    // the first open page of the run.
    const session = await attachPageSession(
      conn,
      opts.engineTabId ? { preferTargetId: opts.engineTabId } : {},
    );
    try {
      await conn.call("Network.setCookie", params, 10_000, session.sessionId);
    } finally {
      await session.release();
    }
  } finally {
    conn.close();
  }
}

/**
 * Delete every cookie matching the filter; returns how many matched.
 * `Network.deleteCookies` has no browserContextId param — partition
 * deletes attach to a live page in the partition and delete from its
 * session, so the partition's own store is what gets surgery.
 */
export async function clearCookies(
  wsEndpoint: string,
  filter: CookieFilter,
  opts: ListCookiesOptions = {},
): Promise<number> {
  const conn = await CdpConnection.connect(wsEndpoint, 10_000);
  try {
    const cookies =
      opts.engineTabIds && opts.engineTabIds.size > 0
        ? await listContextCookies(conn, opts.engineTabIds)
        : await listViaPageSession(conn, "Network.getAllCookies");
    const targets = cookies.filter((c) => matches(c, filter));

    const tabId = opts.engineTabIds ? [...opts.engineTabIds][0] : undefined;
    const session = await attachPageSession(conn, tabId ? { preferTargetId: tabId } : {});
    try {
      for (const c of targets) {
        // deleteCookies matches on name+domain+path regardless of expiry;
        // domain-less (host-keyed) cookies delete best-effort.
        const params: Record<string, unknown> = {
          name: c.name,
          path: c.path || "/",
        };
        if (c.domain) params.domain = c.domain;
        await conn.call("Network.deleteCookies", params, 10_000, session.sessionId).catch(() => {});
      }
    } finally {
      await session.release();
    }
    return targets.length;
  } finally {
    conn.close();
  }
}
