import { DomainError, ErrorCodes } from "@queuepilot/contracts";
import { GoogleAuthService } from "../google/google-auth.service.js";
import type { ResolverRegistry } from "./resolver-registry.js";

/**
 * gmail resolver — OAuth-backed (see google-oauth.ts), the modern path now
 * that Google is killing app passwords:
 *
 *   gmail:<account>[?query=<gmail-search>]
 *
 * - <account> is whatever name was used in `GET /oauth/google/start?account=`.
 * - query is any Gmail search expression, default `is:unseen in:inbox`.
 * - Returns the newest matching message's text/plain body (HTML stripped if
 *   the message has no plain part). The CALLER hands the text to a parser.
 *
 * Named errors only, per registry contract: `#NO ACCOUNT` (no tokens / no
 * match), `#API ERROR ...` for upstream failures.
 */

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

export function registerGmailResolver(
  reg: ResolverRegistry,
  google: GoogleAuthService,
): void {
  reg.register("gmail", async (args, ctx) => {
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
