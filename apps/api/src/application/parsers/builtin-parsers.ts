import type {
  MailMessage,
  ParserArgs,
  ParserDefinition,
  ParserRegistry,
} from "./parser-registry.js";

/**
 * In-tree parsers. Each is written from Jancy's PUBLISHED description and
 * example (docs.jancy.io/docs/resolver-columns "Included Email/SMS Parsers",
 * /docs/jyl/email-parser-tag, /docs/included-plugins/parser-registry) — not
 * from Jancy's code, which is not public.
 *
 * Status of each code pattern:
 *   - smsdeliverer-ticketmaster, sms google: the docs publish the exact
 *     message format → exact.
 *   - ticketmaster / ticketmaster-v2 (email), sms ticketmaster: the docs
 *     publish the SEARCH (subjects, To/From) but not a full email. The code
 *     pattern is deliberately conservative (a 6-digit code near the word
 *     "code"), and MUST be re-checked against the owner's sample emails
 *     (round-2 B1) before it is called done.
 */

const TM_SUBJECTS = ["Here's Your Authentication Code", "Your request to reset password"];

function tmSubjectMatches(subject: string): boolean {
  const s = subject.toLowerCase();
  return TM_SUBJECTS.some((x) => s.includes(x.toLowerCase()));
}

/** A 6-digit code, preferring one introduced by "code"; never inside a longer number. */
export function sixDigitCode(text: string): string | null {
  const near = /code[^0-9]{0,40}?(?<!\d)(\d{6})(?!\d)/i.exec(text);
  if (near) return near[1]!;
  const any = /(?<![\d$.,-])(\d{6})(?![\d.,])/.exec(text);
  return any ? any[1]! : null;
}

/**
 * The profile email goes into a Gmail search string, so only a plain
 * address is accepted — quotes, spaces, braces or parentheses could widen
 * the search to other mail (Codex review). A malformed email = #BAD PARSER.
 */
const PLAIN_EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

function canRunTm(args: ParserArgs): boolean {
  return (
    (args.resolverName === "gmail" || args.resolverName === "imap" || args.resolverName === "aycd") &&
    PLAIN_EMAIL.test(args.profile.email ?? "") &&
    args.site === "ticketmaster"
  );
}

const ticketmaster: ParserDefinition = {
  kind: "email-parser",
  name: "ticketmaster",
  apiVersion: 2,
  description:
    "Ticketmaster authentication-code or password-reset emails sent TO the profile's email. " +
    "Site:Ticketmaster only; requires the profile's Email. Works with gmail and imap.",
  example: "Subject: Here's Your Authentication Code — Your code is 123456",
  canRun: canRunTm,
  getQuery(args) {
    const email = args.profile.email!;
    if (args.resolverName === "gmail") {
      return `{subject:"${TM_SUBJECTS[0]}" subject:"${TM_SUBJECTS[1]}"} to:${email}`;
    }
    return { to: email, or: TM_SUBJECTS.map((subject) => ({ subject })) };
  },
  parseMessage(msg: MailMessage) {
    if (!tmSubjectMatches(msg.subject)) return null;
    return sixDigitCode(`${msg.subject}\n${msg.text}`);
  },
  // AYCD Inbox: Inbox matches the To address itself (task.email = profile
  // email), so the filter is the subject; the code regex mirrors sixDigitCode.
  aycdTask: () => ({
    mailFilters: [
      {
        target: "subject",
        comparator: "includes",
        value: TM_SUBJECTS[0]!,
        orValues: TM_SUBJECTS.slice(1),
      },
    ],
    // Plain RE2-safe patterns (no lookaround): AYCD runs them in its own app.
    mailElements: [
      { name: "code", target: "body", regex: "[Cc]ode[^0-9]{0,40}?([0-9]{6})\\b" },
      { name: "anyCode", target: "body", regex: "\\b([0-9]{6})\\b" },
    ],
    resultElements: ["code", "anyCode"],
  }),
};

const ticketmasterV2: ParserDefinition = {
  ...ticketmaster,
  name: "ticketmaster-v2",
  description:
    "Like `ticketmaster`, but the profile's email may be in To OR From (forwarded mail). " +
    "Site:Ticketmaster only; works with gmail and imap.",
  getQuery(args) {
    const email = args.profile.email!;
    if (args.resolverName === "gmail") {
      return `{subject:"${TM_SUBJECTS[0]}" subject:"${TM_SUBJECTS[1]}"} {to:${email} from:${email}}`;
    }
    // One `or` per SearchObject: match the address here, the subject in parseMessage.
    return { or: [{ to: email }, { from: email }] };
  },
};

const smsdelivererTicketmaster: ParserDefinition = {
  kind: "email-parser",
  name: "smsdeliverer-ticketmaster",
  apiVersion: 2,
  description:
    "Emails from SMSDeliverer carrying a Ticketmaster 2FA text for the profile's SMS Number. " +
    "Site:Ticketmaster only; requires the SMS Number column.",
  example:
    "Sender: 77598\nReceiver: 12223334444\nTimestamp: 2/4/2023 5:49:02 PM\n411733 is your Ticketmaster code.",
  canRun: (args) => !!args.profile.smsNumber && args.site === "ticketmaster",
  getQuery(args) {
    const n = `${args.profile.smsNumberCountryCode ?? "1"}${args.profile.smsNumber}`;
    if (args.resolverName === "gmail") {
      return `(+(Receiver:) +(${n}) +(is your Ticketmaster code))`;
    }
    return { body: `Receiver: ${n}` };
  },
  parseMessage(msg: MailMessage) {
    return /(\d+) is your Ticketmaster code/.exec(msg.text)?.[1] ?? null;
  },
};

const smsTicketmaster: ParserDefinition = {
  kind: "sms-parser",
  name: "ticketmaster",
  apiVersion: 2,
  description: "Ticketmaster 2FA text messages.",
  example: "411733 is your Ticketmaster code.",
  parseMessage(msg: string) {
    return /(\d{4,8}) is your Ticketmaster (?:verification |authentication )?code/i.exec(msg)?.[1] ?? null;
  },
};

const smsGoogle: ParserDefinition = {
  kind: "sms-parser",
  name: "google",
  apiVersion: 2,
  description: "Google verification text messages.",
  example: "G-928862 is your Google verification code.",
  parseMessage(msg: string) {
    return /g-(\d+) is your google verification code\./i.exec(msg)?.[1] ?? null;
  },
};

export const BUILTIN_EMAIL_PARSERS = [ticketmaster, ticketmasterV2, smsdelivererTicketmaster];
/** SMS parsers share names with email parsers in Jancy; ours are prefixed `sms-` to keep one namespace. */
export const BUILTIN_SMS_PARSERS = [
  { ...smsTicketmaster, name: "sms-ticketmaster" },
  { ...smsGoogle, name: "sms-google" },
];

export function registerBuiltinParsers(reg: ParserRegistry): void {
  for (const def of [...BUILTIN_EMAIL_PARSERS, ...BUILTIN_SMS_PARSERS]) {
    reg.register(def, "builtin", `builtin:${def.name}`);
  }
}

/**
 * Generic OTP parser, configured inline — for every site without a
 * dedicated parser (AXS, SeatGeek, MLB, Etix, … until real samples exist):
 *
 *   otp(from=<text>;subject=<text>;len=<4-10>;to=profile|any)
 *
 * e.g. `emailcode=aycd:@aycd:otp(from=axs.com;subject=code)`. Options are
 * `;`-separated (a `,` would split the Jancy Site cell). from/subject are
 * "contains" matches; len is the code length (default 6); to=profile (the
 * default) only accepts mail addressed to the profile's email. Works with
 * gmail, imap and aycd. Values are restricted to a safe charset because
 * they go into Gmail/IMAP searches.
 */
const OTP_VALUE = /^[A-Za-z0-9@._+' -]{1,80}$/;

export function otpParser(spec: string): ParserDefinition | string {
  const m = /^otp\((.*)\)$/s.exec(spec.trim());
  if (!m) return `#NO PARSER ${spec}`;
  const opts: Record<string, string> = {};
  for (const part of m[1]!.split(";")) {
    if (!part.trim()) continue;
    const eq = part.indexOf("=");
    if (eq === -1) return `#BAD PARSER otp option "${part.trim()}" needs key=value`;
    const k = part.slice(0, eq).trim().toLowerCase();
    const v = part.slice(eq + 1).trim();
    if (!["from", "subject", "len", "to"].includes(k)) return `#BAD PARSER otp option "${k}" is unknown (from, subject, len, to)`;
    if (!OTP_VALUE.test(v)) return `#BAD PARSER otp ${k} has characters outside letters, digits, @ . _ + ' - and space`;
    opts[k] = v;
  }
  const len = opts.len ? Number(opts.len) : 6;
  if (!Number.isInteger(len) || len < 4 || len > 10) return "#BAD PARSER otp len must be 4–10";
  const toMode = (opts.to ?? "profile").toLowerCase();
  if (toMode !== "profile" && toMode !== "any") return "#BAD PARSER otp to must be profile or any";
  if (!opts.from && !opts.subject) return "#BAD PARSER otp needs from= or subject= (otherwise any code-looking mail matches)";
  const from = opts.from?.toLowerCase();
  const subject = opts.subject?.toLowerCase();
  const near = new RegExp(`code[^0-9]{0,40}?(?<!\\d)(\\d{${len}})(?!\\d)`, "i");
  const any = new RegExp(`(?<![\\d$.,-])(\\d{${len}})(?![\\d.,])`);
  return {
    kind: "email-parser",
    name: spec.trim(),
    apiVersion: 2,
    description: "Inline generic OTP parser.",
    canRun: (args) =>
      ["gmail", "imap", "aycd"].includes(args.resolverName) &&
      (toMode === "any" || PLAIN_EMAIL.test(args.profile.email ?? "")),
    getQuery(args) {
      if (args.resolverName === "gmail") {
        const q: string[] = [];
        if (opts.from) q.push(`from:(${opts.from})`);
        if (opts.subject) q.push(`subject:("${opts.subject}")`);
        if (toMode === "profile") q.push(`to:${args.profile.email}`);
        return q.join(" ");
      }
      const s: Record<string, string> = {};
      if (opts.from) s.from = opts.from;
      if (opts.subject) s.subject = opts.subject;
      if (toMode === "profile") s.to = args.profile.email!;
      return s;
    },
    parseMessage(msg: MailMessage) {
      if (subject && !msg.subject.toLowerCase().includes(subject)) return null;
      if (from && !msg.from.toLowerCase().includes(from)) return null;
      const text = `${msg.subject}\n${msg.text}`;
      return near.exec(text)?.[1] ?? any.exec(text)?.[1] ?? null;
    },
    aycdTask: () => ({
      mailFilters: [
        ...(opts.subject ? [{ target: "subject" as const, comparator: "includes" as const, value: opts.subject }] : []),
        ...(opts.from ? [{ target: "from" as const, comparator: "includes" as const, value: opts.from }] : []),
      ],
      mailElements: [
        { name: "code", target: "body" as const, regex: `[Cc]ode[^0-9]{0,40}?([0-9]{${len}})\\b` },
        { name: "anyCode", target: "body" as const, regex: `\\b([0-9]{${len}})\\b` },
      ],
      resultElements: ["code", "anyCode"],
    }),
  };
}

/** Registry lookup that also understands inline `otp(...)` specs. */
export function lookupParser(
  reg: ParserRegistry,
  name: string,
): { kind: ParserDefinition["kind"]; def: ParserDefinition } | string {
  if (name.trim().toLowerCase().startsWith("otp(")) {
    const def = otpParser(name);
    return typeof def === "string" ? def : { kind: def.kind, def };
  }
  return reg.get(name) ?? `#NO PARSER ${name}`;
}
