import { randomUUID } from "node:crypto";
import { lookupParser } from "../parsers/builtin-parsers.js";
import type { ParserArgs, ParserRegistry } from "../parsers/parser-registry.js";
import { DEFAULT_EMAIL_PARSER, parserArgsFrom } from "./code-pipeline.js";

/**
 * AYCD Inbox "Inbox API" (Mail Tasks) — the owner's AYCD code source.
 *
 * Contract (AYCD developer docs "Inbox | Tasks API" + their public client
 * gitlab.com/aycd-inc/inbox-api-clients/inbox-api-client-js, read 2026-11-19;
 * this is our own client, not a copy):
 *   POST {base}/api/v1/tasks/mail/create          body MailTask → { id }
 *   GET  {base}/api/v1/tasks/completed?group=<g>  → { tasks: MailTaskResponse[] }
 *   GET  {base}/api/v1/user/verify                → 2xx | 401
 *   header  Authorization: Token <Inbox API key>
 * The API is a cloud relay to the user's RUNNING Inbox desktop app — Inbox
 * closed ⇒ 401. Completed tasks are fetched per `group` (ours is random per
 * process, like AYCD's client) and polled ~every 3 s, shared across all
 * waiting tasks so N concurrent resolves cost one poll.
 *
 * A task finds ONE email sent TO `email`, received after `receivedAt`
 * (epoch s), matching `mailFilters`, and returns `mailElements` values —
 * never the body. So a parser must describe its AYCD task (aycdTask()).
 */

export const AYCD_API_BASE = "https://inbox-api.aycd.io";

export interface AycdMailFilter {
  target: "subject" | "from";
  comparator: "includes" | "excludes" | "matches" | "findByRegex";
  value: string;
  orValues?: string[];
  optional?: boolean;
  regexReplaceAll?: string;
}

export interface AycdMailElement {
  name: string;
  target: "subject" | "body" | "from";
  selector?: string;
  regex?: string;
  regexSource?: "pretty" | "raw";
  formatter?: "text" | "html" | "link" | "numeric";
}

export interface AycdTaskSpec {
  mailFilters: AycdMailFilter[];
  mailElements: AycdMailElement[];
  /** Elements holding the code, in preference order (first line of the first non-empty). */
  resultElements: string[];
}

interface MailTaskResponse {
  id: string;
  status: string;
  results?: Record<string, string>;
}

export interface AycdClientOptions {
  base?: string;
  fetch?: typeof fetch;
  /** Poll interval (AYCD's client: 3000 ms). Tests shorten it. */
  pollMs?: number;
}

/**
 * One client per API key. Waiters share a single poll loop; completed tasks
 * that belong to nobody (yet) are kept 10 minutes, as AYCD's client does.
 */
export class AycdInboxClient {
  private readonly group = `queuepilot-${randomUUID()}`;
  private readonly done = new Map<string, { res: MailTaskResponse; at: number }>();
  private poll: Promise<void> | null = null;
  private lastPoll = 0;
  private lastError: Error | null = null;

  constructor(
    private readonly apiKey: string,
    private readonly opts: AycdClientOptions = {},
  ) {}

  private get base(): string {
    return (this.opts.base ?? AYCD_API_BASE).replace(/\/+$/, "");
  }

  private async http(path: string, init: RequestInit = {}): Promise<Response> {
    const f = this.opts.fetch ?? fetch;
    let res: Response;
    try {
      res = await f(`${this.base}${path}`, {
        ...init,
        headers: { ...(init.headers as Record<string, string>), authorization: `Token ${this.apiKey}` },
        // Audit: a stalled relay must not hold a resolve past its deadline,
        // and the key header must never follow a redirect elsewhere.
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        redirect: "error",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        /timeout|abort/i.test(msg) ? "#API ERROR AYCD Inbox did not answer in time" : `#API ERROR AYCD Inbox ${msg.slice(0, 120)}`,
      );
    }
    if (res.status === 401) {
      throw new Error("#BAD ACCT AYCD Inbox rejected the API key (is the Inbox app running?)");
    }
    if (res.status === 429) throw new Error("#API ERROR AYCD Inbox rate limit (429)");
    if (!res.ok) throw new Error(`#API ERROR AYCD Inbox HTTP ${res.status}`);
    return res;
  }

  /** `GET /api/v1/user/verify` — is the key valid and Inbox running? */
  async verify(): Promise<{ ok: boolean; error: string | null }> {
    try {
      await this.http("/api/v1/user/verify");
      return { ok: true, error: null };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg.replace(/^#[A-Z ]+?(?= [A-Z])\s*/, "").trim() || msg };
    }
  }

  async create(task: {
    email: string;
    receivedAt: number;
    timeout: number;
    templateId?: string | undefined;
    mailFilters: AycdMailFilter[];
    mailElements: AycdMailElement[];
  }): Promise<string> {
    const body = { ...task, group: this.group };
    if (!body.templateId) delete body.templateId;
    const res = await this.http("/api/v1/tasks/mail/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { id?: string };
    if (!json.id) throw new Error("#API ERROR AYCD Inbox returned no task id");
    return json.id;
  }

  /** Waits for task `id` up to `timeoutSec` (+ a poll of slack). */
  async waitFor(id: string, timeoutSec: number): Promise<MailTaskResponse> {
    const deadline = Date.now() + timeoutSec * 1000 + this.pollMs();
    for (;;) {
      const hit = this.done.get(id);
      if (hit) {
        this.done.delete(id);
        return hit.res;
      }
      if (this.lastError) {
        const e = this.lastError;
        this.lastError = null;
        throw e;
      }
      if (Date.now() > deadline) return { id, status: "timeout" };
      // Never wait on an in-flight poll past our own deadline.
      await Promise.race([this.pollOnce(), sleep(Math.max(0, deadline - Date.now()))]);
      if (!this.done.has(id)) await sleep(Math.min(this.pollMs(), Math.max(0, deadline - Date.now())));
    }
  }

  private pollMs(): number {
    return this.opts.pollMs ?? 3000;
  }

  private pollOnce(): Promise<void> {
    if (this.poll) return this.poll;
    if (Date.now() - this.lastPoll < this.pollMs()) return Promise.resolve();
    this.poll = (async () => {
      try {
        const res = await this.http(`/api/v1/tasks/completed?group=${encodeURIComponent(this.group)}`);
        const json = (await res.json()) as { tasks?: MailTaskResponse[] };
        const now = Date.now();
        for (const t of json.tasks ?? []) if (t.id) this.done.set(t.id, { res: t, at: now });
        for (const [k, v] of this.done) if (now - v.at > 10 * 60_000) this.done.delete(k);
      } catch (err) {
        this.lastError = err instanceof Error ? err : new Error(String(err));
      } finally {
        this.lastPoll = Date.now();
        this.poll = null;
      }
    })();
    return this.poll;
  }
}

const HTTP_TIMEOUT_MS = 15_000;

/**
 * Masks inline AYCD API keys in a spec before it is echoed back (resolve
 * responses carry the Site cell). `aycd:@alias` is left alone — the alias
 * NAME is not a secret, and aliases are the recommended way to hold keys.
 */
export function redactAycdKeys(spec: string): string {
  return spec.replace(/\baycd:(?!@)[^:,\s]+/g, "aycd:***");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * The API key travels in every request, so an overridden base (tests, a
 * local fake) must be https or loopback — never plain http elsewhere.
 */
export function safeAycdBase(base: string | undefined): string {
  if (!base) return AYCD_API_BASE;
  let u: URL;
  try {
    u = new URL(base);
  } catch {
    throw new Error(`SPECTRA_AYCD_API_BASE is not a URL: ${base}`);
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) {
    throw new Error("SPECTRA_AYCD_API_BASE must be https:// (or http:// on loopback)");
  }
  if (u.username || u.password) throw new Error("SPECTRA_AYCD_API_BASE must not carry credentials");
  // Normalised: origin + path only (no query, fragment or userinfo).
  return `${u.origin}${u.pathname}`.replace(/\/+$/, "");
}

export interface AycdResolverOptions {
  parsers: ParserRegistry;
  settings?: () => AycdCodeSettings;
  client?: Omit<AycdClientOptions, "base"> & { base?: string | undefined };
}

export const DEFAULT_AYCD_SETTINGS: AycdCodeSettings = { lookbackMin: 10, timeoutSec: 60 };

/**
 * `aycd:<api-key | @alias>[:<parser>[:<templateId>]]` → a code from AYCD
 * Inbox. The key is the Inbox API key (Inbox → Settings → Tasks (API));
 * store it as a token alias so it never sits in the CSV. `templateId` is
 * AYCD's Mail Task Template, for catch-all / forwarding accounts.
 */
/** Stored-key alias the console writes and CSVs reference as `aycd:@aycd`. */
export const AYCD_KEY_ALIAS = "aycd";

export function registerAycdResolver(
  reg: import("../resolvers/resolver-registry.js").ResolverRegistry,
  options: AycdResolverOptions,
): { verify(key: string): Promise<{ ok: boolean; error: string | null }> } {
  const base = safeAycdBase(options.client?.base);
  const clients = new Map<string, AycdInboxClient>();
  const clientFor = (key: string): AycdInboxClient => {
    let c = clients.get(key);
    if (!c) {
      c = new AycdInboxClient(key, { ...options.client, base });
      clients.set(key, c);
    }
    return c;
  };
  // Audit: concurrent resolves for the same key + email + parser + template
  // share ONE Inbox task, so a burst (or a loop) doesn't spam the user's Inbox.
  const inflight = new Map<string, Promise<string>>();
  reg.register("aycd", async (_args, ctx) => {
    const [key = "", parserName, templateId] = (ctx.resolverArgs ?? []).map((s) => s.trim());
    if (!key) return "#NO API KEY aycd expects aycd:<api-key>[:<parser>[:<templateId>]]";
    if (key.startsWith("@")) return `#BAD ALIAS ${key}`;
    const args = parserArgsFrom("aycd", ctx);
    const dedupe = JSON.stringify([key, args.profile.email, parserName ?? "", templateId ?? "", args.site]);
    const running = inflight.get(dedupe);
    if (running) return running;
    const p = runAycdCodeTask({
      client: clientFor(key),
      parsers: options.parsers,
      parserName,
      templateId: templateId || undefined,
      args,
      settings: options.settings?.() ?? DEFAULT_AYCD_SETTINGS,
    }).finally(() => inflight.delete(dedupe));
    inflight.set(dedupe, p);
    return p;
  });
  return { verify: (key: string) => clientFor(key).verify() };
}

export interface AycdCodeSettings {
  /** How far back an already-arrived email still counts (minutes). */
  lookbackMin: number;
  /** How long to wait for the email (seconds; AYCD max 3600). */
  timeoutSec: number;
}

/**
 * The aycd resolver's flow, Jancy error names:
 *   parser (default "ticketmaster") → #NO PARSER / #BAD PARSER
 *   → canRun(args) and parser.aycdTask(args)   → #BAD PARSER
 *   → create task (To = profile email, receivedAt = now − lookback)
 *   → wait: success → code | timeout → #NO MSG | error → #BAD ACCT <why>
 */
export async function runAycdCodeTask(opts: {
  client: AycdInboxClient;
  parsers: ParserRegistry;
  parserName: string | undefined;
  templateId: string | undefined;
  args: ParserArgs;
  settings: AycdCodeSettings;
  now?: () => number;
}): Promise<string> {
  const name = opts.parserName?.trim() || DEFAULT_EMAIL_PARSER;
  const parser = lookupParser(opts.parsers, name);
  if (typeof parser === "string") return parser;
  const def = parser.def;
  if (parser.kind !== "email-parser" || !def.aycdTask) {
    return `#BAD PARSER ${name} has no AYCD Inbox task`;
  }
  let spec: AycdTaskSpec;
  try {
    if (def.canRun && !def.canRun(opts.args)) return `#BAD PARSER ${name}`;
    spec = def.aycdTask(opts.args);
  } catch (err) {
    return `#BAD PARSER ${name}: ${err instanceof Error ? err.message : String(err)}`;
  }
  const email = opts.args.profile.email;
  if (!email) return "#BAD PARSER the profile has no Email";

  const nowSec = Math.floor((opts.now ?? Date.now)() / 1000);
  const timeout = Math.min(3600, Math.max(5, Math.trunc(opts.settings.timeoutSec)));
  try {
    const id = await opts.client.create({
      email,
      // AYCD wants mail that arrives AFTER receivedAt. "Refresh code" usually
      // runs after the email landed, so look back; minus a few seconds for
      // clock drift, as AYCD recommends.
      receivedAt: nowSec - Math.max(0, opts.settings.lookbackMin) * 60 - 10,
      timeout,
      templateId: opts.templateId,
      mailFilters: spec.mailFilters,
      mailElements: spec.mailElements,
    });
    const res = await opts.client.waitFor(id, timeout);
    if (res.status === "timeout") return "#NO MSG";
    if (res.status !== "success") {
      const why = res.results?.errorStatus ?? res.results?.errorMessage ?? res.status;
      return `#BAD ACCT ${why}`.slice(0, 240);
    }
    for (const el of spec.resultElements) {
      const value = (res.results?.[el] ?? "").split("\n")[0]!.trim();
      if (value) return value;
    }
    return "#PARSE FAILED";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return msg.startsWith("#") ? msg : `#API ERROR ${msg.slice(0, 200)}`;
  }
}
