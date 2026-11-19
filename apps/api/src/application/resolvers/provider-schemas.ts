import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ResolverContext, ResolverRegistry } from "./resolver-registry.js";
import type { ParserRegistry } from "../parsers/parser-registry.js";
import { siteKindOf } from "../email/code-pipeline.js";

/**
 * J2 — provider connectors as SCHEMA FILES, not code.
 *
 * None of the SMS / password services the owner uses (TextChest, SeatHeroes,
 * SMSGateway, TextTrove, QuickText, Wired, Automatiq, 1Ticket, Lysted,
 * TicketSuite, Victory Live) publishes its API contract publicly (checked
 * 2026-11-19). Instead of guessing endpoints, each provider is a JSON file in
 * `<dataDir>/providers/<name>.json` — written from the provider's own docs in
 * the owner's dashboard — that registers a resolver under the provider's
 * NAME, so Jancy's grammar works unchanged:
 *
 *   smscode=textchest:@textchest[:<sms-parser>]        (kind "sms")
 *   password=automatiq:@aq-token:<company>[:<siteId>]  (kind "password")
 *
 * Positional args after the key fill `{arg1}`, `{arg2}` … in the request.
 * Request templates may use {key} {arg1..arg4} {smsNumber} {smsNumberFull}
 * {email} {siteId} — every value is URL-encoded, and the request host must
 * stay the schema's own host (https, or loopback for tests), so a CSV can
 * only fill values, never redirect the request or the key.
 *
 * Trust: schema files are operator-owned config in the data dir, like
 * parsers and plugins; they never execute code.
 */

const Template = z.string().max(2000);

const ProviderSchemaSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]{1,39}$/, "lowercase name, 2-40 chars"),
  kind: z.enum(["sms", "password"]),
  description: z.string().max(500).optional(),
  request: z.object({
    method: z.enum(["GET", "POST"]).default("GET"),
    url: Template,
    headers: z.record(Template).default({}),
    /** JSON body template (POST); string leaves are templated. */
    body: z.unknown().optional(),
  }),
  response: z.object({
    /** sms: dotted path to the message array (e.g. "data.messages"); "" = root. */
    messages: z.string().max(200).default(""),
    /** sms: field inside one message holding its text. */
    text: z.string().max(200).default("message"),
    /** sms: optional field holding the message time (ISO or epoch s/ms). */
    date: z.string().max(200).optional(),
    /** password: dotted path to the value, or to an array filtered by `match`. */
    value: z.string().max(200).default("password"),
    /** password: pick the array item whose `field` equals `equals` (templated). */
    match: z.object({ array: z.string().max(200), field: z.string().max(200), equals: Template, value: z.string().max(200) }).optional(),
    /** Optional error detection: when this path is truthy, its value is the error. */
    error: z.string().max(200).optional(),
  }),
  /** Per-site ids for {siteId} — Jancy's marketplace/site ids (TM 92, AXS 276 …). */
  siteIds: z.record(z.string().max(40)).default({}),
  /** Default SMS parser (Jancy: ticketmaster). */
  defaultParser: z.string().max(80).default("ticketmaster"),
});
export type ProviderSchema = z.infer<typeof ProviderSchemaSchema>;

/** Dotted path with [n] indexes: "data.items[0].text"; "" or "$" = root. */
export function pick(obj: unknown, p: string): unknown {
  const clean = p.replace(/^\$\.?/, "");
  if (!clean) return obj;
  let cur: unknown = obj;
  for (const seg of clean.split(".")) {
    const m = /^([^[\]]*)((?:\[\d+\])*)$/.exec(seg);
    if (!m) return undefined;
    if (m[1]) {
      if (typeof cur !== "object" || cur === null) return undefined;
      cur = (cur as Record<string, unknown>)[m[1]];
    }
    for (const idx of m[2]!.matchAll(/\[(\d+)\]/g)) {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[Number(idx[1])];
    }
  }
  return cur;
}

function fill(t: string, vars: Record<string, string>, encode: boolean): string {
  return t.replace(/\{(\w+)\}/g, (_m, k: string) => {
    const v = vars[k] ?? "";
    if (!encode) return v;
    // Audit: "." / ".." survive encodeURIComponent and would move the path.
    return /^\.{1,2}$/.test(v) ? v.replace(/\./g, "%2E") : encodeURIComponent(v);
  });
}

/** Masks every stored-secret value inside text a provider sent back. */
function redactSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) if (s.length >= 4) out = out.split(s).join("***");
  return out;
}

function fillDeep(v: unknown, vars: Record<string, string>): unknown {
  if (typeof v === "string") return fill(v, vars, false);
  if (Array.isArray(v)) return v.map((x) => fillDeep(x, vars));
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fillDeep(x, vars)]));
  }
  return v;
}

function hostOf(url: string): string | null {
  try {
    const u = new URL(url);
    const loop = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
    if (u.protocol !== "https:" && !(u.protocol === "http:" && loop)) return null;
    return u.host;
  } catch {
    return null;
  }
}

function toTime(v: unknown): number | null {
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
  if (typeof v === "string" && v) {
    const n = Number(v);
    if (Number.isFinite(n)) return n < 1e12 ? n * 1000 : n;
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

export interface SchemaResolverDeps {
  parsers: ParserRegistry;
  /** SMS "newer than" window in minutes (0 = off); default 10. */
  smsMaxAgeMin?: () => number;
  now?: () => number;
}

/** Runs one provider schema for one resolve. Never throws. */
export async function runProviderSchema(
  schema: ProviderSchema,
  ctx: ResolverContext,
  deps: SchemaResolverDeps,
): Promise<string> {
  const [key = "", ...rest] = (ctx.resolverArgs ?? []).map((s) => s.trim());
  if (!key) return `#NO API KEY ${schema.name} expects ${schema.name}:<api-key>…`;
  if (key.startsWith("@")) return `#BAD ALIAS ${key}`;
  // Audit: a stored secret may only fill the KEY slot — never another arg a
  // schema might place in a URL/body that the provider could echo back.
  const secrets = (ctx.usedAliases ?? [])
    .map((n) => ctx.aliases?.get(n) ?? null)
    .filter((v): v is string => typeof v === "string" && v.length > 0);
  if (rest.some((a) => secrets.some((s) => a.includes(s)))) {
    return `#BAD ALIAS stored secrets may only be the ${schema.name} API key (first argument)`;
  }
  const site = ctx.siteKind ?? siteKindOf(ctx.site);
  const sms = ctx.profile?.smsNumber ?? "";
  const cc = ctx.profile?.smsNumberCountryCode ?? "1";
  if (schema.kind === "sms" && !sms) return "#NO SMS NUMBER";
  // Positional args after the key: sms → [parser]; password → [arg1..].
  const vars: Record<string, string> = {
    key,
    smsNumber: sms,
    smsNumberFull: sms ? `${cc}${sms}` : "",
    email: ctx.email ?? "",
    siteId: schema.siteIds[site] ?? "",
    site,
  };
  rest.forEach((a, i) => (vars[`arg${i + 1}`] = a));

  const url = fill(schema.request.url, vars, true);
  const schemaHost = hostOf(schema.request.url.replace(/\{\w+\}/g, "x"));
  if (!schemaHost || hostOf(url) !== schemaHost) return `#API ERROR ${schema.name}: request host changed or not https`;
  const f = ctx.fetch ?? fetch;
  let json: unknown;
  try {
    const headers = Object.fromEntries(
      Object.entries(schema.request.headers).map(([k, v]) => [k, fill(v, vars, false)]),
    );
    if (Object.values(headers).some((v) => /[\r\n\0]/.test(v))) {
      return `#API ERROR ${schema.name}: a header value contains a line break`;
    }
    const init: RequestInit = { method: schema.request.method, headers, redirect: "error", signal: AbortSignal.timeout(15_000) };
    if (schema.request.method === "POST" && schema.request.body !== undefined) {
      init.body = JSON.stringify(fillDeep(schema.request.body, vars));
      (init.headers as Record<string, string>)["content-type"] ??= "application/json";
    }
    const res = await f(url, init);
    if (res.status === 401 || res.status === 403) return `#API ERROR ${schema.name} rejected the key (HTTP ${res.status})`;
    if (!res.ok) return `#API ERROR ${schema.name} HTTP ${res.status}`;
    json = await res.json();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `#API ERROR ${schema.name}: ${/timeout|abort/i.test(msg) ? "no answer in time" : redactSecrets(msg, [key, ...secrets]).slice(0, 120)}`;
  }

  if (schema.response.error) {
    const e = pick(json, schema.response.error);
    if (e) return `#ERROR ${redactSecrets(String(e), [key, ...secrets]).slice(0, 160)}`;
  }

  if (schema.kind === "password") {
    if (schema.response.match) {
      const m = schema.response.match;
      const arr = pick(json, m.array);
      if (!Array.isArray(arr) || arr.length === 0) return "#NO PASSWORD";
      const want = fill(m.equals, vars, false);
      const hit = arr.find((x) => String(pick(x, m.field) ?? "") === want);
      if (!hit) return "#NO ACCOUNT";
      const v = pick(hit, m.value);
      return typeof v === "string" && v ? v : "#NO PASSWORD";
    }
    const v = pick(json, schema.response.value);
    return typeof v === "string" && v ? v : "#NO PASSWORD";
  }

  // sms: newest first, inside the window, first one the SMS parser accepts.
  const list = pick(json, schema.response.messages);
  if (!Array.isArray(list) || list.length === 0) return "#NO MSG";
  const now = (deps.now ?? Date.now)();
  const maxAge = (deps.smsMaxAgeMin?.() ?? 10) * 60_000;
  const items = list
    .map((m) => ({
      text: String(pick(m, schema.response.text) ?? ""),
      at: schema.response.date ? toTime(pick(m, schema.response.date)) : null,
    }))
    .filter((m) => m.text)
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  const fresh = maxAge > 0 ? items.filter((m) => m.at === null || now - m.at <= maxAge) : items;
  if (fresh.length === 0) return "#FILTERED MSG";
  const parserName = rest[0] || schema.defaultParser;
  const parser = deps.parsers.get(`sms-${parserName}`) ?? deps.parsers.get(parserName);
  if (!parser) return `#NO PARSER ${parserName}`;
  if (parser.kind !== "sms-parser") return `#BAD PARSER ${parserName} is not an SMS parser`;
  for (const m of fresh) {
    const r = deps.parsers.run(parser.name, { subject: "", from: "", body: m.text });
    if (r.ok && r.code) return r.code;
  }
  return "#NO MSG";
}

/**
 * Loads every `<dir>/*.json` schema and registers a resolver per provider.
 * A schema whose name collides with an existing resolver (gmail, imap,
 * aycd, …) is refused. Returns load errors; never throws.
 */
export function loadProviderSchemas(
  dir: string,
  reg: ResolverRegistry,
  deps: SchemaResolverDeps,
): { loaded: string[]; errors: { file: string; error: string }[] } {
  const loaded: string[] = [];
  const errors: { file: string; error: string }[] = [];
  if (!fs.existsSync(dir)) return { loaded, errors };
  const taken = new Set(reg.list().map((r) => r.name));
  for (const entry of fs.readdirSync(dir).sort()) {
    if (!entry.toLowerCase().endsWith(".json")) continue;
    try {
      const schema = ProviderSchemaSchema.parse(JSON.parse(fs.readFileSync(path.join(dir, entry), "utf8")));
      if (!hostOf(schema.request.url.replace(/\{\w+\}/g, "x"))) {
        throw new Error("request.url must be https:// (http only on loopback) with a fixed host");
      }
      if (taken.has(schema.name)) throw new Error(`a resolver named "${schema.name}" already exists`);
      reg.register(schema.name, (_args, ctx) => runProviderSchema(schema, ctx, deps));
      taken.add(schema.name);
      loaded.push(schema.name);
    } catch (err) {
      errors.push({ file: entry, error: err instanceof Error ? err.message.slice(0, 300) : String(err) });
    }
  }
  return { loaded, errors };
}
