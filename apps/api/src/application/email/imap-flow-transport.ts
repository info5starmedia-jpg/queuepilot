import { ImapFlow, type SearchObject } from "imapflow";
import type { MailMessage, ParserQuery } from "../parsers/parser-registry.js";
import { parseRawMail, type EmailTransport } from "./code-pipeline.js";

/**
 * IMAP transport for the email-code pipeline, on imapflow — the library
 * Jancy's IMAP resolver is built on, so a parser's `getQuery()` ImapFlow
 * SearchObject (`{ to, or: [{ subject }…], body, since … }`) means exactly
 * what it means in Jancy. Messages are parsed with mailparser (Jancy hands
 * parsers a Nodemailer mail object).
 *
 * Errors are Jancy's names: `#CONN ERROR` for connect/login failures.
 */

export interface ImapCreds {
  host: string;
  port: number;
  tls: boolean;
  user: string;
  pass: string;
  /** Mailbox to search; Jancy uses INBOX. */
  mailbox?: string;
}

/** The slice of ImapFlow this transport uses — tests inject a fake. */
export interface ImapClientLike {
  connect(): Promise<void>;
  getMailboxLock(path: string): Promise<{ release(): void }>;
  search(query: SearchObject, opts: { uid: true }): Promise<number[] | false>;
  fetchOne(
    uid: string,
    query: { source: true; internalDate: true },
    opts: { uid: true },
  ): Promise<{ source?: Buffer; internalDate?: Date | string } | false>;
  logout(): Promise<void>;
}

export type ImapClientFactory = (creds: ImapCreds) => ImapClientLike;

const CONNECT_TIMEOUT_MS = 20_000;

export const defaultImapClientFactory: ImapClientFactory = (c) =>
  new ImapFlow({
    host: c.host,
    port: c.port,
    secure: c.tls,
    auth: { user: c.user, pass: c.pass },
    logger: false,
    connectionTimeout: CONNECT_TIMEOUT_MS,
    greetingTimeout: CONNECT_TIMEOUT_MS,
  }) as unknown as ImapClientLike;

export function imapFlowTransport(
  creds: ImapCreds,
  factory: ImapClientFactory = defaultImapClientFactory,
): EmailTransport {
  return {
    resolverName: "imap",
    async fetch(query: ParserQuery, { max }): Promise<MailMessage[]> {
      const search: SearchObject =
        typeof query === "string"
          ? // A Gmail-style string makes no sense over IMAP; search the
            // text so a hand-written parser still gets candidates.
            query.trim() ? { body: query } : { all: true }
          : (query as SearchObject);
      const client = factory(creds);
      try {
        await client.connect();
      } catch (err) {
        throw new Error(`#CONN ERROR ${redact(errText(err), creds.pass)}`);
      }
      try {
        const lock = await client.getMailboxLock(creds.mailbox ?? "INBOX");
        try {
          const uids = (await client.search(search, { uid: true })) || [];
          // Highest UID = newest; newest first, at most `max`.
          const newest = [...uids].sort((a, b) => b - a).slice(0, max);
          const out: MailMessage[] = [];
          for (const uid of newest) {
            const m = await client.fetchOne(String(uid), { source: true, internalDate: true }, { uid: true });
            if (!m || !m.source) continue;
            const internal = m.internalDate ? new Date(m.internalDate) : null;
            out.push(await parseRawMail(m.source, `imap:${uid}`, internal));
          }
          return out;
        } finally {
          lock.release();
        }
      } catch (err) {
        const msg = errText(err);
        throw new Error(msg.startsWith("#") ? msg : `#API ERROR imap ${redact(msg, creds.pass).slice(0, 200)}`);
      } finally {
        try {
          await client.logout();
        } catch {
          /* best-effort */
        }
      }
    },
  };
}

function redact(s: string, secret: string): string {
  return secret ? s.split(secret).join("***") : s;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
