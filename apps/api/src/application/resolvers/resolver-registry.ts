import { substituteAliases, type AliasStore } from "./token-aliases.js";

/**
 * Resolver registry — the Jancy 2FA layer's core. A resolver turns
 * `name:remainder` into a dynamic value (a password, an SMS code, an email
 * code) at assignment time; the remainder is passed verbatim so URLs and
 * secrets containing ':' survive. Built-ins cover the generic shapes; plugins
 * register the rest (gmail, imap, smsgateway, provider-specific APIs).
 *
 * Error taxonomy follows Jancy's: failures are named strings (`#API ERROR`,
 * `#NO ACCOUNT`, ...) so the caller can show them inline instead of a bare
 * failure. A resolver NEVER throws for an upstream problem — it returns
 * `#...`; it throws only for programmer error (unknown resolver).
 */

export interface ResolverContext {
  profileId?: string | undefined;
  email?: string | undefined;
  site?: string | undefined;
  field?: string | undefined;
  /** Injectable for tests; defaults to global fetch. */
  fetch?: typeof fetch;
  /** Alias store forwarded by resolve() — resolvers like imap use it for
   *  `@alias` credentials inside their spec. */
  aliases?: import("./token-aliases.js").AliasStore | undefined;
  /**
   * Jancy's Resolver-object view of the same spec: `name:one:two:three` →
   * `["one","two","three"]`. Filled by resolve(); Jancy-grammar resolvers
   * (gmail:acct:parser:label, imap:host:port:user:pass:parser, sms
   * providers) read this, older URL-style resolvers keep reading `args`.
   */
  resolverArgs?: string[] | undefined;
  /** Jancy site kind for the matched Site column: ticketmaster | axs | other. */
  siteKind?: "ticketmaster" | "axs" | "other" | undefined;
  /** The tab URL the value is being resolved for (Jancy sets it for `other`). */
  url?: string | undefined;
  /** Profile fields parsers and SMS resolvers read (Jancy's args.profile). */
  profile?: {
    name?: string | undefined;
    smsNumber?: string | undefined;
    smsNumberCountryCode?: string | undefined;
  } | undefined;
}

export type ResolverFn = (
  args: string,
  ctx: ResolverContext,
) => Promise<string>;

export class ResolverRegistry {
  private readonly resolvers = new Map<string, ResolverFn>();

  register(name: string, fn: ResolverFn): void {
    if (this.resolvers.has(name)) {
      throw new Error(`resolver "${name}" is already registered`);
    }
    this.resolvers.set(name, fn);
  }

  /** Removes every resolver under a prefix (plugin disable/teardown). */
  unregisterByPrefix(prefix: string): number {
    let n = 0;
    for (const name of [...this.resolvers.keys()]) {
      if (name.startsWith(prefix)) {
        this.resolvers.delete(name);
        n++;
      }
    }
    return n;
  }

  list(): { name: string }[] {
    return [...this.resolvers.keys()].map((name) => ({ name }));
  }

  /** `spec` = `name:remainder` — the remainder is passed VERBATIM to the
   *  resolver, so values containing ':' (URLs, JSON paths, secrets) survive.
   *  Each resolver parses its own remainder. Jancy's static form `$literal`
   *  returns everything after the `$` untouched (no alias expansion — it is
   *  a literal). */
  async resolve(
    spec: string,
    ctx: ResolverContext,
    aliases?: AliasStore,
  ): Promise<string> {
    if (spec.startsWith("$")) return spec.slice(1);
    const expanded = aliases ? substituteAliases(spec, aliases) : spec;
    const idx = expanded.indexOf(":");
    const name = idx === -1 ? expanded : expanded.slice(0, idx);
    const fn = this.resolvers.get(name);
    if (!fn) return `#NO RESOLVER ${name}`;
    const args = idx === -1 ? "" : expanded.slice(idx + 1);
    // Positional args are split BEFORE alias expansion and expanded one by
    // one, so an `@alias` secret containing ':' (an IMAP password, an API
    // key) stays a single argument. Inline values with ':' still split —
    // same as Jancy; aliases are the way to store them.
    const rawIdx = spec.indexOf(":");
    const rawArgs = rawIdx === -1 ? "" : spec.slice(rawIdx + 1);
    const full: ResolverContext = {
      ...ctx,
      resolverArgs:
        rawArgs === ""
          ? []
          : rawArgs.split(":").map((a) => (aliases ? substituteAliases(a, aliases) : a)),
      ...(aliases ? { aliases } : {}),
    };
    try {
      return await fn(args, full);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return msg.startsWith("#") ? msg : `#API ERROR ${msg.slice(0, 200)}`;
    }
  }
}

/** Built-ins: static literal, and a generic webhook covering the common
 *  "POST {token, email} → JSON with the code" shape used by smsgateway /
 *  textchest / victorylive-style providers. Provider plugins override these
 *  names never — they register their own. */
export function registerBuiltinResolvers(reg: ResolverRegistry): void {
  reg.register("static", async (args) => args);
  reg.register("env", async (args) => {
    const v = process.env[args];
    if (v === undefined) throw new Error(`#NO ACCOUNT env:${args}`);
    return v;
  });
  reg.register("webhook", async (args, ctx) => {
    // webhook:<url>[:<jsonPath>] — POSTs {email, site, field}, extracts the
    // code by dotted path from the JSON response (default path: "code").
    // The url may itself contain ':' (scheme, port), so the jsonPath is
    // only split off the END when the tail looks like a plain dotted path.
    let url = args;
    let jsonPath = "code";
    const i = args.lastIndexOf(":");
    if (i > 0) {
      const tail = args.slice(i + 1);
      if (/^[A-Za-z0-9_.]+$/.test(tail) && !tail.includes("/")) {
        url = args.slice(0, i);
        jsonPath = tail;
      }
    }
    if (!url) return "#BAD ALIAS webhook needs a url";
    const f = ctx.fetch ?? fetch;
    const res = await f(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: ctx.email ?? null,
        site: ctx.site ?? null,
        field: ctx.field ?? null,
      }),
    });
    if (res.status === 401 || res.status === 403) return "#NO ACCOUNT";
    if (!res.ok) return `#API ERROR HTTP ${res.status}`;
    const body = (await res.json()) as Record<string, unknown>;
    let cur: unknown = body;
    for (const part of jsonPath.split(".")) {
      if (typeof cur !== "object" || cur === null) return "#NO PASSWORD";
      cur = (cur as Record<string, unknown>)[part];
    }
    if (typeof cur !== "string" || cur.length === 0) return "#NO PASSWORD";
    return cur;
  });
}

/**
 * Parses a Jancy site-column spec into field→resolverSpec pairs:
 *   `password=static: hunter2, smscode=webhook:https://x/y:code, othercode=...`
 * Split on a comma that starts the next `field=` (Jancy writes `, `), then
 * the first '='. Values may contain ':' (resolver args) and stray commas.
 */
export function parseSiteSpec(spec: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of spec.split(/,\s*(?=[A-Za-z_][\w-]*\s*=)/)) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const field = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (field && value) out[field] = value;
  }
  return out;
}

/**
 * Resolves one field for a profile+site from its stored Site columns
 * (`profile.extra.sites`: { "ticketmaster": "password=...", "axs": ... }).
 * Most specific site wins; "*" is the wildcard fallback, Jancy's order.
 */
export async function resolveSiteField(
  sites: Record<string, string> | undefined,
  site: string,
  field: string,
  ctx: ResolverContext,
  reg: ResolverRegistry,
  aliases?: AliasStore,
): Promise<{ found: boolean; value?: string; spec?: string }> {
  if (!sites) return { found: false };
  const spec = sites[site] ?? sites["*"];
  if (!spec) return { found: false };
  const fields = parseSiteSpec(spec);
  const resolverSpec = fields[field];
  if (!resolverSpec) return { found: false, spec };
  return { found: true, spec, value: await reg.resolve(resolverSpec, { ...ctx, site, field }, aliases) };
}

/**
 * Jancy's built-in brand Site columns (docs.jancy.io/docs/resolver-columns).
 * Jancy matches a brand when the URL merely CONTAINS one of its domains; we
 * match at host-label boundaries instead (see hostMatchesDomain), because a
 * Site column resolves PASSWORDS that autofill types into the page —
 * `ticketmaster.com.evil.net` or `evil.net/?ticketmaster.com` must not get
 * them. `am.ticketmaster.com` and `www.ticketmaster.com.mx` still match.
 * MLB is ours (owner's site list); `Site:mlb.com` works too.
 */
const SITE_BRANDS: Record<string, { kind: "ticketmaster" | "axs" | "other"; domains: string[] }> = {
  ticketmaster: {
    kind: "ticketmaster",
    domains: [
      "ticketmaster.com", "ticketmaster.ca", "ticketmaster.nl", "ticketmaster.de",
      "ticketmaster.co.uk", "ticketmaster.co.nz", "ticketmaster.be", "livenation.com",
    ],
  },
  axs: { kind: "axs", domains: ["axs.com"] },
  mlb: { kind: "other", domains: ["mlb.com"] },
};

export interface SiteMatch {
  /** The Site column key as written after `Site:` in the CSV. */
  column: string;
  spec: string;
  siteKind: "ticketmaster" | "axs" | "other";
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * `domain` matches `host` when it occupies whole labels: the host IS the
 * domain, ends with `.domain`, or is (sub.)domain followed by exactly one
 * 2–3 letter country label (`ticketmaster.com.mx`, `….com.au`). Anything with
 * more labels after the domain (`ticketmaster.com.evil.net`) does not match.
 */
export function hostMatchesDomain(host: string, domain: string): boolean {
  const d = domain.toLowerCase().replace(/^\.+|\.+$/g, "");
  if (!host || !d) return false;
  if (host === d || host.endsWith(`.${d}`)) return true;
  return new RegExp(`^(?:.+\\.)?${escapeRegex(d)}\\.[a-z]{2,3}$`).test(host);
}

/**
 * Picks the Site column that applies to a tab URL, Jancy's rules:
 *  1. brand columns (`Ticketmaster`, `AXS`, `MLB`, any case) match by domain;
 *  2. every other column is evaluated IN FILE ORDER: `*` matches anything; a
 *     domain-style pattern (no `/`) matches the host at label boundaries; a
 *     pattern containing `/` keeps Jancy's literal `^.*<pattern>.*$` test on
 *     the full URL (that is the only way to target a path). Hence `Site:*`
 *     must come last.
 */
export function matchSiteColumn(
  sites: Record<string, string> | undefined,
  url: string,
): SiteMatch | null {
  if (!sites) return null;
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    host = "";
  }
  for (const [column, spec] of Object.entries(sites)) {
    const brand = SITE_BRANDS[column.trim().toLowerCase()];
    if (brand && brand.domains.some((d) => hostMatchesDomain(host, d))) {
      return { column, spec, siteKind: brand.kind };
    }
  }
  for (const [column, spec] of Object.entries(sites)) {
    if (SITE_BRANDS[column.trim().toLowerCase()]) continue;
    const patterns = column.split(";").map((p) => p.trim()).filter(Boolean);
    const hit = patterns.some(
      (p) =>
        p === "*" ||
        (p.includes("/")
          ? new RegExp(`^.*${escapeRegex(p)}.*$`, "i").test(url)
          : hostMatchesDomain(host, p)),
    );
    if (hit) return { column, spec, siteKind: "other" };
  }
  return null;
}

/** URL-driven variant of resolveSiteField — what a tab-aware caller uses. */
export async function resolveSiteFieldForUrl(
  sites: Record<string, string> | undefined,
  url: string,
  field: string,
  ctx: ResolverContext,
  reg: ResolverRegistry,
  aliases?: AliasStore,
): Promise<{ found: boolean; value?: string; spec?: string; column?: string }> {
  const match = matchSiteColumn(sites, url);
  if (!match) return { found: false };
  const resolverSpec = parseSiteSpec(match.spec)[field];
  if (!resolverSpec) return { found: false, spec: match.spec, column: match.column };
  const value = await reg.resolve(
    resolverSpec,
    { ...ctx, site: match.siteKind, siteKind: match.siteKind, url, field },
    aliases,
  );
  return { found: true, spec: match.spec, column: match.column, value };
}
