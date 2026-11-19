import { connect as tlsConnect, type ConnectionOptions, type TLSSocket } from "node:tls";
import { connect as netConnect, type Socket } from "node:net";
import type { ResolverRegistry } from "./resolver-registry.js";
import { substituteAliases, type AliasStore } from "./token-aliases.js";
import type { ParserRegistry } from "../parsers/parser-registry.js";
import {
  DEFAULT_EMAIL_CODE_SETTINGS,
  parserArgsFrom,
  runEmailCodePipeline,
  type EmailCodeSettings,
} from "../email/code-pipeline.js";
import {
  imapFlowTransport,
  type ImapClientFactory,
  type ImapCreds,
} from "../email/imap-flow-transport.js";

/**
 * IMAP resolver — the gmail/app-password path. Jancy's `imap` resolver shape:
 *
 *   imap://<host>[:<port>][?user=<spec>&pass=<spec>][&query=<imap-search>]
 *
 * - user/pass may be `@alias` references (substituted from the alias store
 *   before connect; a missing alias fails as `#NO ACCOUNT alias <name>`).
 * - query defaults to `UNSEEN` (plus UNKEYWORD queuepilot once we flag seen
 *   codes). Any RFC 3501 SEARCH keys are passed through verbatim.
 * - On a match, the newest matching message's text is handed to the parser
 *   registry by the CALLER — this resolver returns raw body text.
 *
 * Failures are named strings (`#NO ACCOUNT`, `#NO PASSWORD`, `#API ERROR`),
 * never throws, per the registry's contract. TLS is default; port 143
 * implies STARTTLS is NOT attempted — plain there, explicit `?tls=false` for
 * lab use only.
 */

export type ImapConnect = (opts: {
  host: string;
  port: number;
  tls: boolean;
  tlsOptions?: ConnectionOptions;
  timeoutMs: number;
}) => Promise<SocketLike>;

/**
 * Stored email accounts (Settings → Integrations). `imap:you@gmail.com`
 * resolves through this instead of inline user/pass.
 */
export interface ImapAccountLookup {
  forEmail(email: string): { host: string; port: number; tls: boolean; user: string; pass: string } | null;
}

export interface ImapResolverOptions {
  /** Injectable for tests; defaults to a real TCP/TLS connect. */
  connect?: ImapConnect;
  /** Stored accounts; absent = only the inline imap://host?user=&pass= form. */
  accounts?: ImapAccountLookup;
  /**
   * Parser registry → enables the Jancy code forms (docs.jancy.io/docs/
   * resolver-columns), which return a CODE via the email-code pipeline:
   *   imap:<host>:<port>:<user>:<pass>:<parser>   (Jancy; 5 args or #BAD ARG COUNT)
   *   imap:<stored-account-email>:<parser>         (ours: Settings → Integrations)
   * The raw forms above keep returning the body.
   */
  parsers?: ParserRegistry;
  settings?: () => EmailCodeSettings;
  /** imapflow client factory — tests inject a fake. */
  imapClientFactory?: ImapClientFactory;
  /** Extra IMAP hosts trusted with `@alias` passwords (stored accounts' hosts). */
  trustedHosts?: () => string[];
}

/**
 * SEC-1: an `@alias` (stored secret) used as an IMAP credential is only sent
 * to a host the operator can be presumed to trust — the big mail providers,
 * loopback (AYCD Inbox's local IMAP Server), or a host they added in
 * Settings → Integrations. A third-party CSV naming `imap:evil.com:993:…
 * :@gmailpw:…` gets #BAD ALIAS instead of the password.
 */
export const TRUSTED_IMAP_HOSTS = [
  "imap.gmail.com",
  "outlook.office365.com",
  "imap-mail.outlook.com",
  "imap.mail.yahoo.com",
  "imap.mail.me.com",
  "imap.aol.com",
  "imap.zoho.com",
  "127.0.0.1",
  "localhost",
  "::1",
];

function aliasHostRefusal(
  host: string,
  tls: boolean,
  usedAliases: string[] | undefined,
  extra: (() => string[]) | undefined,
): string | null {
  if (!usedAliases || usedAliases.length === 0) return null;
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  const trusted = [...TRUSTED_IMAP_HOSTS, ...(extra?.() ?? []).map((x) => x.toLowerCase())];
  if (!trusted.includes(h)) {
    return `#BAD ALIAS @${usedAliases[0]} is only sent to known mail hosts — add ${h} under Settings → Integrations to trust it`;
  }
  // Audit: the CSV picks the port; a stored password must not go out in
  // the clear to a remote host (STARTTLS can be stripped). Loopback (AYCD's
  // local IMAP Server) is exempt — it never leaves the machine.
  const loopback = h === "127.0.0.1" || h === "localhost" || h === "::1";
  if (!tls && !loopback) {
    return `#BAD ALIAS @${usedAliases[0]} is only sent over TLS (use port 993) to ${h}`;
  }
  return null;
}

/**
 * The Jancy code form of `imap:…`, or null when `resolverArgs` is a raw form.
 * Throws `#…` errors for a recognisable-but-wrong code form.
 */
function jancyImapForm(
  resolverArgs: string[],
  accounts: ImapAccountLookup | undefined,
): { creds: ImapCreds; parser: string } | null {
  const a = resolverArgs.map((s) => s.trim());
  if (a.length >= 2 && /^\d+$/.test(a[1]!)) {
    if (a.length !== 5) {
      throw new Error("#BAD ARG COUNT imap expects imap:<host>:<port>:<user>:<pass>:<parser>");
    }
    const [host, port, user, pass, parser] = a as [string, string, string, string, string];
    const p = Number(port);
    // 993 = implicit TLS (imaps). Any other port connects plain and
    // imapflow upgrades with STARTTLS when the server offers it.
    return { creds: { host, port: p, tls: p === 993, user, pass }, parser };
  }
  if (a.length === 2 && /^[^\s/?@]+@[^\s/?]+$/.test(a[0]!) && a[1]) {
    const account = accounts?.forEmail(a[0]!);
    if (!account) throw new Error(`#BAD ACCT ${a[0]} is not added in Settings → Integrations`);
    return { creds: account, parser: a[1]! };
  }
  return null;
}

/** Minimal socket surface the resolver needs — real sockets and test fakes. */
export interface SocketLike {
  write(line: string): void;
  end(): void;
  onData(cb: (chunk: string) => void): void;
  onClose(cb: () => void): void;
  onError(cb: (err: Error) => void): void;
}

const IMAP_TIMEOUT_MS = 20_000;

class ImapSession {
  private tagCounter = 0;
  private buffer = "";
  private pending: {
    tag: string;
    resolve: (lines: string[]) => void;
  } | null = null;
  private current: string[] = [];
  private closed = false;
  // NOTE: declaration order matters — with useDefineForClassFields the field
  // initializer below would be overwritten if `onEnded` were declared after.
  private onEnded: () => void = () => {};
  private readonly ended = new Promise<void>((resolve) => {
    this.onEnded = resolve;
  });
  private error: Error | null = null;

  constructor(private readonly sock: SocketLike) {
    sock.onData((chunk) => this.feed(chunk));
    sock.onClose(() => {
      this.closed = true;
      this.flushPending(new Error("#API ERROR connection closed"));
      this.onEnded();
    });
    sock.onError((err) => {
      this.error = err;
      this.flushPending(err);
      this.onEnded();
    });
  }

  private flushPending(err: Error): void {
    if (this.pending) {
      const p = this.pending;
      this.pending = null;
      p.resolve([`${p.tag} ${err.message}`]);
    }
  }

  private feed(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const idx = this.buffer.indexOf("\r\n");
      if (idx === -1) return;
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    const p = this.pending;
    if (!p) return; // untagged greetings etc. before first command
    this.current.push(line);
    if (line.startsWith(p.tag + " ")) {
      this.pending = null;
      const lines = this.current;
      this.current = [];
      p.resolve(lines);
    }
  }

  /** Sends one command, resolves with all response lines (incl. tagged end). */
  async command(cmd: string): Promise<string[]> {
    if (this.closed) throw this.error ?? new Error("#API ERROR connection closed");
    const tag = `qp${++this.tagCounter}`;
    const lines = await new Promise<string[]>((resolve) => {
      this.pending = { tag, resolve };
      this.sock.write(`${tag} ${cmd}\r\n`);
    });
    const end = lines[lines.length - 1]!;
    if (end.startsWith(`${tag} NO`) || end.startsWith(`${tag} BAD`)) {
      throw new Error(`#NO ACCOUNT ${end.slice(tag.length + 1, 120)}`);
    }
    return lines;
  }

  async done(): Promise<void> {
    try {
      this.sock.end();
    } catch {
      /* ignore */
    }
    await this.ended;
  }
}

function parseImapUrl(
  args: string,
  aliases: AliasStore | undefined,
): { host: string; port: number; tls: boolean; user: string; pass: string; query: string } {
  // args arrives with the leading "imap:" already split off by the registry —
  // so the remainder is "//host[:port][?query]"; accept both with and without
  // the slashes for hand-typed specs.
  const m = /^(?:\/\/)?([^:/?]+)(?::(\d+))?(\?.+)$/.exec(args.trim());
  if (!m) throw new Error("#BAD ALIAS imap expects imap://host[:port]?user=&pass=[&query=][&tls=false]");
  const host = m[1]!;
  const port = m[2] ? Number(m[2]) : 993;
  const params = new URLSearchParams(m[3] ?? "");
  const tlsParam = params.get("tls");
  const tls = tlsParam === null ? port !== 143 : tlsParam !== "false";
  const rawUser = params.get("user") ?? "";
  const rawPass = params.get("pass") ?? "";
  const user = aliases ? substituteAliases(rawUser, aliases) : rawUser;
  const pass = aliases ? substituteAliases(rawPass, aliases) : rawPass;
  if (!user) throw new Error("#NO ACCOUNT imap user missing");
  // An @alias that survived substitution verbatim was never defined.
  for (const [raw, sub, what] of [
    [rawUser, user, "user"],
    [rawPass, pass, "pass"],
  ] as const) {
    if (raw.startsWith("@") && sub === raw) {
      throw new Error(`#NO ACCOUNT alias ${raw.slice(1)} (${what})`);
    }
  }
  if (!pass) throw new Error("#NO PASSWORD imap pass missing");
  const query = (params.get("query") ?? "UNSEEN").trim() || "UNSEEN";
  return { host, port, tls, user, pass, query };
}

function extractTextBody(lines: string[]): string {
  // RFC 3501 FETCH response: lines contain `* n FETCH (BODY[TEXT] {size}` then
  // raw text lines then `)`. We re-join everything and pick the largest block.
  let text = "";
  let inLiteral = false;
  for (const line of lines) {
    if (/^\* \d+ FETCH/.test(line)) {
      const lit = /\{(\d+)\}\s*$/.exec(line);
      inLiteral = lit !== null;
      continue;
    }
    if (line === ")") {
      inLiteral = false;
      continue;
    }
    if (inLiteral && line.length > text.length) text = line;
  }
  return text;
}

/** Real TCP/TLS connect, shared by the resolver and the account login test. */
const defaultImapConnect: ImapConnect = (o) =>
        new Promise((resolve, reject) => {
          const onSocket = (s: Socket | TLSSocket) => {
            s.setTimeout(o.timeoutMs, () => {
              s.destroy(new Error("#API ERROR timeout"));
            });
            const like: SocketLike = {
              write: (l) => s.write(l),
              end: () => s.end(),
              onData: (cb) => s.on("data", (d: Buffer) => cb(d.toString("utf8"))),
              onClose: (cb) => s.on("close", cb),
              onError: (cb) => s.on("error", cb),
            };
            resolve(like);
          };
          if (o.tls) {
            const s = tlsConnect(
              { host: o.host, port: o.port, servername: o.host },
              () => onSocket(s),
            );
            s.once("error", reject);
          } else {
            const s = netConnect({ host: o.host, port: o.port }, () => onSocket(s));
            s.once("error", reject);
          }
        });

/**
 * `imap:you@gmail.com[?query=…]` → a stored account's credentials. Returns
 * null when the spec is not the account form (so the inline form applies).
 */
function accountSpec(
  args: string,
  accounts: ImapAccountLookup | undefined,
): { host: string; port: number; tls: boolean; user: string; pass: string; query: string } | null {
  const m = /^(?:\/\/)?([^\s/?:@]+@[^\s/?:]+)(\?.*)?$/.exec(args.trim());
  if (!m) return null;
  const email = decodeURIComponent(m[1]!);
  const account = accounts?.forEmail(email);
  if (!account) throw new Error(`#NO ACCOUNT ${email} is not added in Settings → Integrations`);
  const params = new URLSearchParams(m[2] ?? "");
  const query = (params.get("query") ?? "UNSEEN").trim() || "UNSEEN";
  return { ...account, query };
}

/**
 * Log in and open INBOX — the console's "Test" button for a stored account.
 * The answer names what failed; the password never appears in it.
 */
export async function imapLoginCheck(
  creds: { host: string; port: number; tls: boolean; user: string; pass: string },
  connect: ImapConnect = defaultImapConnect,
): Promise<{ ok: boolean; error: string | null }> {
  let session: ImapSession | null = null;
  try {
    const sock = await connect({ host: creds.host, port: creds.port, tls: creds.tls, timeoutMs: IMAP_TIMEOUT_MS });
    session = new ImapSession(sock);
    await session.command("CAPABILITY");
    await session.command(`LOGIN ${quoteImap(creds.user)} ${quoteImap(creds.pass)}`);
    await session.command("SELECT INBOX");
    return { ok: true, error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const clean = msg.replace(/^#NO ACCOUNT\s*/, "").replace(creds.pass, "***").slice(0, 200);
    return { ok: false, error: /LOGIN|auth|credentials|invalid/i.test(clean) ? `login refused: ${clean}` : clean };
  } finally {
    try {
      if (session) {
        await session.command("LOGOUT");
        await session.done();
      }
    } catch {
      /* teardown best-effort */
    }
  }
}

/** Registers `imap` on the given registry. */
export function registerImapResolver(
  reg: ResolverRegistry,
  options: ImapResolverOptions = {},
): void {
  reg.register("imap", async (args, ctx) => {
    if (options.parsers && !args.startsWith("//") && !args.includes("?")) {
      let form: ReturnType<typeof jancyImapForm>;
      try {
        form = jancyImapForm(ctx.resolverArgs ?? args.split(":"), options.accounts);
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
      if (form) {
        const refusal = aliasHostRefusal(form.creds.host, form.creds.tls, ctx.usedAliases, options.trustedHosts);
        if (refusal) return refusal;
        const settings = options.settings?.() ?? DEFAULT_EMAIL_CODE_SETTINGS;
        return runEmailCodePipeline({
          parsers: options.parsers,
          parserName: form.parser,
          args: parserArgsFrom("imap", ctx),
          transport: imapFlowTransport(form.creds, options.imapClientFactory),
          // Jancy's IMAP side has no per-request cap setting; parsers'
          // queries are narrow, a few candidates covers retries.
          max: 3,
          newerThan: settings.imapNewerThan,
        });
      }
    }
    let parsed;
    try {
      parsed = accountSpec(args, options.accounts) ?? parseImapUrl(args, ctx.aliases);
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    const { host, port, tls, user, pass, query } = parsed;
    const refusal = aliasHostRefusal(host, tls, ctx.usedAliases, options.trustedHosts);
    if (refusal) return refusal;
    const connect = options.connect ?? defaultImapConnect;
    let session: ImapSession | null = null;
    try {
      const sock = await connect({ host, port, tls, timeoutMs: IMAP_TIMEOUT_MS });
      session = new ImapSession(sock);
      await session.command("CAPABILITY");
      await session.command(`LOGIN ${quoteImap(user)} ${quoteImap(pass)}`);
      await session.command("SELECT INBOX");
      const search = await session.command(`SEARCH ${query}`);
      const ids = search
        .filter((l) => l.startsWith("* SEARCH"))
        .flatMap((l) => l.slice(8).trim().split(/\s+/).filter(Boolean).map(Number));
      if (ids.length === 0) return "#NO PASSWORD no matching message";
      const newest = Math.max(...ids);
      const fetched = await session.command(
        `FETCH ${newest} (BODY[TEXT])`,
      );
      const text = extractTextBody(fetched);
      if (!text.trim()) return "#NO PASSWORD empty body";
      return text;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith("#")) return msg;
      return `#API ERROR ${msg.slice(0, 200)}`;
    } finally {
      try {
        if (session) {
          await session.command("LOGOUT");
          await session.done();
        }
      } catch {
        /* teardown best-effort */
      }
    }
  });
}

function quoteImap(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
