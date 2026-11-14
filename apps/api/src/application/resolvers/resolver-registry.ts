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
   *  Each resolver parses its own remainder. */
  async resolve(
    spec: string,
    ctx: ResolverContext,
    aliases?: AliasStore,
  ): Promise<string> {
    const expanded = aliases ? substituteAliases(spec, aliases) : spec;
    const idx = expanded.indexOf(":");
    const name = idx === -1 ? expanded : expanded.slice(0, idx);
    const fn = this.resolvers.get(name);
    if (!fn) return `#NO RESOLVER ${name}`;
    const args = idx === -1 ? "" : expanded.slice(idx + 1);
    const withAliases = aliases ? { ...ctx, aliases } : ctx;
    try {
      return await fn(args, withAliases);
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
 * Split on commas, then first '='. Values may contain ':' (resolver args).
 */
export function parseSiteSpec(spec: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of spec.split(",")) {
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
