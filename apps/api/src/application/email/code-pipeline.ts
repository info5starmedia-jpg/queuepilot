import { simpleParser, type AddressObject } from "mailparser";
import { lookupParser } from "../parsers/builtin-parsers.js";
import type {
  MailMessage,
  ParserArgs,
  ParserQuery,
  ParserRegistry,
} from "../parsers/parser-registry.js";
import type { ResolverContext } from "../resolvers/resolver-registry.js";

/**
 * The email-code pipeline — the piece that was missing (parity D-1): a
 * transport finds messages using the PARSER's query, the parser turns the
 * message into a code. Same flow as Jancy's gmail/imap resolvers
 * (docs.jancy.io/docs/resolver-columns):
 *
 *   parser (named, default "ticketmaster") → #NO PARSER / #BAD PARSER
 *   → canRun(args)                          → #BAD PARSER
 *   → transport.fetch(getQuery(args), max)   → #NO MSG / transport errors
 *   → newer-than filter (setting)            → #FILTERED MSG
 *   → parseMessage(msg, args), newest first  → code / #PARSE FAILED
 */

export const DEFAULT_EMAIL_PARSER = "ticketmaster";

/** Jancy's Settings → Email "Only return emails newer than". */
export type NewerThan = "disabled" | "1h" | "2h";

export function newerThanMs(v: NewerThan | undefined): number | null {
  return v === "1h" ? 3_600_000 : v === "2h" ? 7_200_000 : null;
}

export interface EmailCodeSettings {
  /** Gmail "Max emails per request" (Jancy default 1). */
  gmailMaxPerRequest: number;
  gmailNewerThan: NewerThan;
  imapNewerThan: NewerThan;
}

export const DEFAULT_EMAIL_CODE_SETTINGS: EmailCodeSettings = {
  gmailMaxPerRequest: 1,
  gmailNewerThan: "disabled",
  imapNewerThan: "disabled",
};

/**
 * A transport fetches up to `max` messages matching `query`, NEWEST FIRST.
 * It throws `Error("#…")` for named failures (#BAD ACCT, #CONN ERROR, …).
 */
export interface EmailTransport {
  readonly resolverName: "gmail" | "imap";
  fetch(query: ParserQuery, opts: { max: number }): Promise<MailMessage[]>;
}

/** Builds Jancy's Resolver object from our resolver context. */
export function parserArgsFrom(
  resolverName: string,
  ctx: ResolverContext,
): ParserArgs {
  const site = (ctx.siteKind ?? siteKindOf(ctx.site)) as string;
  return {
    resolverName,
    resolverArgs: ctx.resolverArgs ?? [],
    field: ctx.field ?? "",
    site,
    url: ctx.url,
    profile: {
      email: ctx.email,
      name: ctx.profile?.name,
      smsNumber: ctx.profile?.smsNumber,
      smsNumberCountryCode: ctx.profile?.smsNumberCountryCode,
    },
    email: ctx.email,
  };
}

/** Legacy `site` strings (from `POST …/resolve {site}`) → Jancy's site kind. */
export function siteKindOf(site: string | undefined): "ticketmaster" | "axs" | "other" {
  const s = (site ?? "").toLowerCase();
  return s === "ticketmaster" ? "ticketmaster" : s === "axs" ? "axs" : "other";
}

export async function runEmailCodePipeline(opts: {
  parsers: ParserRegistry;
  parserName: string | undefined;
  args: ParserArgs;
  transport: EmailTransport;
  max: number;
  newerThan: NewerThan;
  now?: () => number;
}): Promise<string> {
  const name = opts.parserName?.trim() || DEFAULT_EMAIL_PARSER;
  const parser = lookupParser(opts.parsers, name);
  if (typeof parser === "string") return parser;
  if (parser.kind !== "email-parser") return `#BAD PARSER ${name} is an SMS parser`;
  const def = parser.def;
  try {
    if (def.canRun && !def.canRun(opts.args)) return `#BAD PARSER ${name}`;
  } catch (err) {
    return `#BAD PARSER ${name}: ${errText(err)}`;
  }

  let query: ParserQuery;
  try {
    query = def.getQuery ? def.getQuery(opts.args) : opts.transport.resolverName === "gmail" ? "" : { all: true };
  } catch (err) {
    return `#BAD PARSER ${name}: ${errText(err)}`;
  }

  let messages: MailMessage[];
  try {
    messages = await opts.transport.fetch(query, { max: Math.max(1, opts.max) });
  } catch (err) {
    const msg = errText(err);
    return msg.startsWith("#") ? msg : `#API ERROR ${msg.slice(0, 200)}`;
  }
  if (messages.length === 0) return "#NO MSG";

  const window = newerThanMs(opts.newerThan);
  const now = (opts.now ?? Date.now)();
  const fresh =
    window === null
      ? messages
      : messages.filter((m) => m.date !== null && now - m.date.getTime() <= window);
  if (fresh.length === 0) return "#FILTERED MSG";

  for (const msg of fresh) {
    try {
      const code = def.parseMessage(msg, opts.args);
      if (code !== null && code !== undefined && String(code) !== "") return String(code);
    } catch (err) {
      return `#PARSE FAILED ${errText(err).slice(0, 200)}`;
    }
  }
  return "#PARSE FAILED";
}

/** Raw RFC 822 source → MailMessage (what parsers see). */
export async function parseRawMail(
  source: Buffer | string,
  id: string,
  fallbackDate: Date | null = null,
): Promise<MailMessage> {
  const parsed = await simpleParser(source);
  const text = (parsed.text ?? "").trim() || stripHtml(typeof parsed.html === "string" ? parsed.html : "");
  return {
    id,
    subject: parsed.subject ?? "",
    from: addressText(parsed.from),
    to: addressText(parsed.to),
    text,
    body: text,
    html: typeof parsed.html === "string" ? parsed.html : "",
    date: parsed.date ?? fallbackDate,
  };
}

function addressText(a: AddressObject | AddressObject[] | undefined): string {
  if (!a) return "";
  return (Array.isArray(a) ? a : [a]).map((x) => x.text).join(", ");
}

export function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
