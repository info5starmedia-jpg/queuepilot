import { DomainError, ErrorCodes } from "@queuepilot/contracts";
import { GoogleAuthService } from "../google/google-auth.service.js";
import type { ResolverRegistry } from "./resolver-registry.js";
import type { MailMessage, ParserQuery, ParserRegistry } from "../parsers/parser-registry.js";
import {
  DEFAULT_EMAIL_CODE_SETTINGS,
  parseRawMail,
  parserArgsFrom,
  runEmailCodePipeline,
  type EmailCodeSettings,
  type EmailTransport,
} from "../email/code-pipeline.js";

/**
 * gmail resolver — OAuth-backed (see google-oauth.ts). Two forms:
 *
 *   gmail:<account>[:<parser>[:<label>]]      Jancy form → a CODE
 *   gmail:<account>?query=<gmail-search>      raw form   → the newest body
 *
 * Jancy form (docs.jancy.io/docs/resolver-columns): the parser (default
 * `ticketmaster`) supplies the Gmail search via getQuery, the label defaults
 * to INBOX, and the parser turns the message into the code. Errors use
 * Jancy's names: #BAD ACCT, #OAUTH ERROR, #BAD LABEL, #NO MSG,
 * #FILTERED MSG, #PARSE FAILED, #NO PARSER, #BAD PARSER, #API ERROR.
 *
 * The raw `?query=` form is the pre-v0.17 behaviour, kept for scripts that
 * want the body itself. Without a parser registry wired (old embedders),
 * the bare form also stays raw.
 */

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

export interface GmailResolverOptions {
  parsers?: ParserRegistry;
  settings?: () => EmailCodeSettings;
}

export function registerGmailResolver(
  reg: ResolverRegistry,
  google: GoogleAuthService,
  options: GmailResolverOptions = {},
): void {
  reg.register("gmail", async (args, ctx) => {
    if (options.parsers && !args.includes("?")) {
      const [account = "", parserName, label] = (ctx.resolverArgs ?? args.split(":")).map((s) => s.trim());
      if (!account) return "#BAD ARG COUNT gmail expects gmail:<account>[:<parser>[:<label>]]";
      const settings = options.settings?.() ?? DEFAULT_EMAIL_CODE_SETTINGS;
      return runEmailCodePipeline({
        parsers: options.parsers,
        parserName,
        args: parserArgsFrom("gmail", ctx),
        transport: gmailTransport(google, account, label || "INBOX", ctx.fetch ?? fetch),
        max: settings.gmailMaxPerRequest,
        newerThan: settings.gmailNewerThan,
      });
    }
    const qIdx = args.indexOf("?");
    const account = (qIdx === -1 ? args : args.slice(0, qIdx)).trim();
    if (!account) return "#BAD ALIAS gmail expects gmail:<account>[?query=...]";
    const query =
      qIdx === -1
        ? "is:unseen in:inbox"
        : new URLSearchParams(args.slice(qIdx + 1)).get("query") ??
          "is:unseen in:inbox";
    const f = ctx.fetch ?? fetch;
    let token: string;
    try {
      token = await google.accessToken(account);
    } catch (err) {
      if (err instanceof DomainError && err.code === ErrorCodes.GOOGLE_NOT_CONNECTED) {
        return `#NO ACCOUNT ${account}`;
      }
      const msg = err instanceof Error ? err.message : String(err);
      return msg.startsWith("#") ? msg : `#API ERROR ${msg.slice(0, 200)}`;
    }
    try {
      const listRes = await f(
        `${GMAIL_API}/messages?maxResults=10&q=${encodeURIComponent(query)}`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      if (listRes.status === 401 || listRes.status === 403) return "#NO ACCOUNT";
      if (!listRes.ok) return `#API ERROR gmail list HTTP ${listRes.status}`;
      const list = (await listRes.json()) as { messages?: { id: string }[] };
      if (!list.messages || list.messages.length === 0) {
        return "#NO PASSWORD no matching message";
      }
      const newest = list.messages[0]!.id;
      const msgRes = await f(`${GMAIL_API}/messages/${newest}?format=full`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!msgRes.ok) return `#API ERROR gmail get HTTP ${msgRes.status}`;
      const msg = (await msgRes.json()) as {
        payload?: {
          mimeType?: string;
          body?: { data?: string };
          parts?: {
            mimeType?: string;
            body?: { data?: string };
            parts?: { mimeType?: string; body?: { data?: string } }[];
          }[];
        };
      };
      const text = extractText(msg.payload);
      if (!text.trim()) return "#NO PASSWORD empty body";
      return text.trim();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return msg.startsWith("#") ? msg : `#API ERROR ${msg.slice(0, 200)}`;
    }
  });
}

/**
 * Gmail transport for the code pipeline: labels resolved by name (#BAD
 * LABEL), list with the parser's query, fetch each hit as RAW RFC 822 and
 * parse it with mailparser — so parsers see the same mail object as over
 * IMAP. Gmail returns newest first.
 */
export function gmailTransport(
  google: GoogleAuthService,
  account: string,
  label: string,
  f: typeof fetch,
): EmailTransport {
  return {
    resolverName: "gmail",
    async fetch(query: ParserQuery, { max }): Promise<MailMessage[]> {
      let token: string;
      try {
        token = await google.accessToken(account);
      } catch (err) {
        if (err instanceof DomainError && err.code === ErrorCodes.GOOGLE_NOT_CONNECTED) {
          throw new Error(`#BAD ACCT ${account}`);
        }
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(/invalid_grant/i.test(msg) ? `#OAUTH ERROR ${account}` : msg);
      }
      const auth = { headers: { authorization: `Bearer ${token}` } };
      const check = (res: Response, what: string): void => {
        if (res.status === 401 || res.status === 403) throw new Error(`#OAUTH ERROR ${account}`);
        if (!res.ok) throw new Error(`#API ERROR gmail ${what} HTTP ${res.status}`);
      };

      let labelId = "INBOX";
      if (label.toUpperCase() !== "INBOX") {
        const res = await f(`${GMAIL_API}/labels`, auth);
        check(res, "labels");
        const labels = ((await res.json()) as { labels?: { id: string; name: string }[] }).labels ?? [];
        const hit = labels.find((l) => l.name.toLowerCase() === label.toLowerCase() || l.id === label);
        if (!hit) throw new Error(`#BAD LABEL ${label}`);
        labelId = hit.id;
      }

      const q = typeof query === "string" ? query : "";
      const listRes = await f(
        `${GMAIL_API}/messages?maxResults=${max}&labelIds=${encodeURIComponent(labelId)}` +
          (q ? `&q=${encodeURIComponent(q)}` : ""),
        auth,
      );
      check(listRes, "list");
      const ids = ((await listRes.json()) as { messages?: { id: string }[] }).messages ?? [];
      const out: MailMessage[] = [];
      for (const { id } of ids.slice(0, max)) {
        const res = await f(`${GMAIL_API}/messages/${id}?format=raw`, auth);
        check(res, "get");
        const m = (await res.json()) as { raw?: string; internalDate?: string };
        if (!m.raw) continue;
        const internal = m.internalDate ? new Date(Number(m.internalDate)) : null;
        out.push(await parseRawMail(Buffer.from(m.raw, "base64url"), `gmail:${id}`, internal));
      }
      return out;
    },
  };
}

function decodeBody(data: string | undefined): string {
  if (!data) return "";
  // Gmail base64url: '-' and '_' instead of '+' '/'; no padding.
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

function stripHtml(html: string): string {
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

function extractText(
  payload:
    | {
        mimeType?: string;
        body?: { data?: string };
        parts?: {
          mimeType?: string;
          body?: { data?: string };
          parts?: { mimeType?: string; body?: { data?: string } }[];
        }[];
      }
    | undefined,
): string {
  if (!payload) return "";
  // Walk parts depth-first, preferring text/plain, falling back to stripped HTML.
  let plain = "";
  let html = "";
  const visit = (p: NonNullable<typeof payload>): void => {
    if (p.mimeType === "text/plain" && p.body?.data) plain += decodeBody(p.body.data) + "\n";
    if (p.mimeType === "text/html" && p.body?.data) html += decodeBody(p.body.data) + "\n";
    for (const sub of p.parts ?? []) visit(sub);
  };
  visit(payload);
  if (plain.trim()) return plain;
  return html ? stripHtml(html) : "";
}
