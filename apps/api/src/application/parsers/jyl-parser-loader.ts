import type { MailMessage, ParserArgs, ParserDefinition, ParserQuery } from "./parser-registry.js";

/**
 * Loads Jancy `.jyl` PARSER files — the published format
 * (docs.jancy.io/docs/jyl/email-parser-tag, /sms-parser-tag):
 *
 *   <jyl user-version="…" user-desc="…">
 *     <email-parser name="x">
 *       <description>…</description> <example>…</example>
 *       <can-run>   JS body (jancy, args)        → boolean </can-run>
 *       <get-query> JS body (jancy, args)        → Gmail string | ImapFlow SearchObject </get-query>
 *       <parse-message> JS body (jancy, args, msg) → code | null </parse-message>
 *     </email-parser>
 *     <sms-parser name="y"> <parse-message> (jancy, args, msg: string) </parse-message> </sms-parser>
 *   </jyl>
 *
 * Only these two tags are supported: <command>, <macro> and
 * <webinterface-endpoint> run against Jancy's window/tab objects, which do
 * not exist here — they are reported, never half-run. Like Jancy, user
 * parsers are registered as `user-<name>`.
 *
 * Trust: the bodies are JavaScript executed in-process — the same model as
 * our `.mjs` parsers and Jancy itself. Only the operator writes the parsers
 * directory. `jancy` is a tiny shim (console.log only); anything else a
 * script reaches for is undefined and fails loudly into #PARSE FAILED /
 * #BAD PARSER.
 */

const SUPPORTED = new Set(["email-parser", "sms-parser"]);
const KNOWN_UNSUPPORTED = new Set(["command", "macro", "webinterface-endpoint"]);

export interface JylLoadResult {
  parsers: ParserDefinition[];
  errors: string[];
}

type Fn = (...a: unknown[]) => unknown;

function compile(params: string[], body: string, where: string): Fn {
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    return new Function(...params, body) as Fn;
  } catch (err) {
    throw new Error(`${where}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function innerTag(block: string, tag: string): string | null {
  const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(block);
  if (!m) return null;
  const raw = m[1]!;
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(raw);
  return (cdata ? cdata[1]! : raw).trim();
}

/** Jancy hands parsers Nodemailer address objects; we expose the same shape. */
function addressObject(text: string): { text: string; value: { address: string; name: string }[] } {
  // Linear on purpose (audit): the header is attacker-controlled mail; a
  // backtracking regex over it could stall the event loop.
  const value: { address: string; name: string }[] = [];
  for (const part of text.slice(0, 2000).split(",").slice(0, 50)) {
    const lt = part.indexOf("<");
    const gt = part.indexOf(">", lt + 1);
    const address = (lt !== -1 && gt !== -1 ? part.slice(lt + 1, gt) : part).trim();
    if (!address.includes("@")) continue;
    const name = (lt !== -1 ? part.slice(0, lt) : "").replace(/"/g, "").trim();
    value.push({ address, name });
  }
  return { text, value };
}

const jancyShim = Object.freeze({
  console: Object.freeze({ log: (...a: unknown[]) => console.log("[jyl]", ...a) }),
});

export function loadJylParsers(source: string, file: string): JylLoadResult {
  const errors: string[] = [];
  const parsers: ParserDefinition[] = [];
  if (!/<jyl\b/i.test(source)) return { parsers, errors: [`${file}: not a .jyl file (no <jyl> tag)`] };

  const tagRe = /<([a-z][a-z-]*)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  const body = /<jyl\b[^>]*>([\s\S]*)<\/jyl>/i.exec(source)?.[1] ?? "";
  for (const m of body.matchAll(tagRe)) {
    const tag = m[1]!.toLowerCase();
    if (!SUPPORTED.has(tag)) {
      errors.push(
        KNOWN_UNSUPPORTED.has(tag)
          ? `${file}: <${tag}> is not supported (it needs Jancy's tab/window objects) — skipped`
          : `${file}: unknown tag <${tag}> — skipped`,
      );
      continue;
    }
    const name = /\bname\s*=\s*"([^"]+)"/i.exec(m[2]!)?.[1]?.trim();
    if (!name) {
      errors.push(`${file}: <${tag}> without a name attribute — skipped`);
      continue;
    }
    const fullName = name.startsWith("user-") ? name : `user-${name}`;
    try {
      const parseSrc = innerTag(m[3]!, "parse-message");
      if (!parseSrc) throw new Error(`<${tag} name="${name}"> needs a <parse-message>`);
      const parse = compile(["jancy", "args", "msg"], parseSrc, `${fullName} parse-message`);
      const description = innerTag(m[3]!, "description") ?? undefined;
      const example = innerTag(m[3]!, "example") ?? undefined;

      if (tag === "sms-parser") {
        parsers.push({
          kind: "sms-parser",
          name: fullName,
          apiVersion: 2,
          ...(description ? { description } : {}),
          ...(example ? { example } : {}),
          parseMessage: (msg: string, args: ParserArgs) => nullable(parse(jancyShim, args, msg)),
        });
        continue;
      }

      const canRunSrc = innerTag(m[3]!, "can-run");
      const querySrc = innerTag(m[3]!, "get-query");
      if (!canRunSrc || !querySrc) {
        throw new Error(`<email-parser name="${name}"> needs <can-run> and <get-query> (Jancy requires both)`);
      }
      const canRun = compile(["jancy", "args"], canRunSrc, `${fullName} can-run`);
      const getQuery = compile(["jancy", "args"], querySrc, `${fullName} get-query`);
      parsers.push({
        kind: "email-parser",
        name: fullName,
        apiVersion: 2,
        ...(description ? { description } : {}),
        ...(example ? { example } : {}),
        canRun: (args) => Boolean(canRun(jancyShim, args)),
        getQuery: (args) => getQuery(jancyShim, args) as ParserQuery,
        parseMessage: (msg: MailMessage, args: ParserArgs) =>
          nullable(
            parse(jancyShim, args, {
              ...msg,
              from: addressObject(msg.from),
              to: addressObject(msg.to),
            }),
          ),
      });
    } catch (err) {
      errors.push(`${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { parsers, errors };
}

function nullable(v: unknown): string | null {
  return v === null || v === undefined || v === "" ? null : String(v);
}
