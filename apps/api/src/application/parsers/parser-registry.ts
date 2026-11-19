import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadJylParsers } from "./jyl-parser-loader.js";

/**
 * Parser registry — Jancy's `jancy://parsers` (docs.jancy.io/docs/included-
 * plugins/parser-registry). Parsers come from three places:
 *   - "builtin": shipped in-tree (builtin-parsers.ts);
 *   - "user":    `<name>.mjs` files in `<dataDir>/parsers/` (rescan);
 *   - a plugin id: registered by a plugin through its context.
 *
 * The contract follows Jancy's parser object (apiVersion 2):
 *
 *   {
 *     kind: "email-parser" | "sms-parser",
 *     name, description?, example?,
 *     canRun?(args)  → boolean          // email: may this parser run here?
 *     getQuery?(args) → Gmail query string (args.resolverName === "gmail")
 *                     | ImapFlow SearchObject (args.resolverName === "imap")
 *     parseMessage(msg, args) → code | null
 *   }
 *
 * `args` is Jancy's Resolver object (ParserArgs below). For email parsers
 * `msg` is a parsed mail (MailMessage: text, html, subject, from, to, date,
 * plus `body` = text for v1 parsers). For SMS parsers `msg` is the message
 * text — EXCEPT for v1 `.mjs` parsers (no `apiVersion`), which keep
 * receiving `{ subject, from, body }` exactly as before.
 *
 * parseMessage returns null for "not this message"; it never has to throw.
 */

/** v1 message shape — still what `POST /parsers/:name/run` takes. */
export interface ParserMessage {
  subject: string;
  from: string;
  body: string;
}

/** A parsed email as parsers see it (Nodemailer-ish, flattened). */
export interface MailMessage extends ParserMessage {
  id: string;
  to: string;
  text: string;
  html: string;
  date: Date | null;
}

/** Jancy's Resolver object, handed to canRun / getQuery / parseMessage. */
export interface ParserArgs {
  resolverName: string;
  resolverArgs: string[];
  field: string;
  /** ticketmaster | axs | other */
  site: string;
  url?: string | undefined;
  profile: {
    email?: string | undefined;
    name?: string | undefined;
    smsNumber?: string | undefined;
    smsNumberCountryCode?: string | undefined;
  };
  /** v1 convenience: canRun/getQuery used to receive `{ email }`. */
  email?: string | undefined;
}

export type ParserQuery = string | Record<string, unknown>;

export interface ParserDefinition {
  kind: "email-parser" | "sms-parser";
  name: string;
  /** 2 = Jancy contract (SMS msg is a string). Absent = v1. */
  apiVersion?: 1 | 2;
  description?: string;
  example?: string;
  canRun?: (args: ParserArgs) => boolean;
  getQuery?: (args: ParserArgs) => ParserQuery;
  /**
   * AYCD Inbox API form of this parser (QueuePilot extension; Jancy has no
   * AYCD resolver). AYCD never returns the body, so the parser describes the
   * filters + the regex element that IS the code. Absent ⇒ the parser can't
   * be used with `aycd:` (#BAD PARSER).
   */
  aycdTask?: (args: ParserArgs) => import("../email/aycd-inbox.js").AycdTaskSpec;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  parseMessage: (message: any, args: ParserArgs) => string | null;
}

export interface LoadedParser {
  name: string;
  kind: ParserDefinition["kind"];
  source: string;
  file: string;
  def: ParserDefinition;
}

export class ParserRegistry {
  private readonly parsers = new Map<string, LoadedParser>();

  constructor(private readonly parsersDir: string) {}

  register(def: ParserDefinition, source: string, file: string): void {
    if (!def.name || typeof def.parseMessage !== "function") {
      throw new Error(`parser from ${file} needs a name and parseMessage()`);
    }
    this.parsers.set(def.name, {
      name: def.name,
      kind: def.kind === "sms-parser" ? "sms-parser" : "email-parser",
      source,
      file,
      def,
    });
  }

  /** Rescan the parsers dir. Only user parsers are replaced — builtins and
   *  plugin parsers stay. A file that fails to load is reported, never
   *  fatal: one bad user script must not take down the rest. */
  async rescan(): Promise<{ loaded: number; errors: { file: string; error: string }[] }> {
    this.unregisterBySource("user");
    const errors: { file: string; error: string }[] = [];
    let loaded = 0;
    if (!fs.existsSync(this.parsersDir)) return { loaded, errors };
    for (const entry of fs.readdirSync(this.parsersDir).sort()) {
      if (entry.toLowerCase().endsWith(".jyl")) {
        // Jancy's published parser format (email-parser / sms-parser tags).
        const file = path.join(this.parsersDir, entry);
        try {
          const { parsers, errors: jylErrors } = loadJylParsers(fs.readFileSync(file, "utf8"), entry);
          for (const def of parsers) {
            this.register(def, "user", file);
            loaded++;
          }
          for (const e of jylErrors) errors.push({ file: entry, error: e });
        } catch (err) {
          errors.push({ file: entry, error: err instanceof Error ? err.message : String(err) });
        }
        continue;
      }
      if (!entry.endsWith(".mjs")) continue;
      const file = path.join(this.parsersDir, entry);
      try {
        // Cache-bust so an edited file is re-read on rescan.
        const href = `${pathToFileURL(file).href}?v=${fs.statSync(file).mtimeMs}`;
        const mod = (await import(href)) as { default?: ParserDefinition };
        const def = mod.default;
        if (!def) throw new Error("no default export");
        this.register(def, "user", file);
        loaded++;
      } catch (err) {
        errors.push({
          file: entry,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { loaded, errors };
  }

  /** Removes every parser from one source (plugin disable/teardown). */
  unregisterBySource(source: string): number {
    let n = 0;
    for (const [name, p] of [...this.parsers.entries()]) {
      if (p.source === source) {
        this.parsers.delete(name);
        n++;
      }
    }
    return n;
  }

  list(): {
    name: string;
    kind: string;
    file: string;
    source: string;
    description: string | null;
    example: string | null;
  }[] {
    return [...this.parsers.values()].map((p) => ({
      name: p.name,
      kind: p.kind,
      file: path.basename(p.file),
      source: p.source,
      description: p.def.description ?? null,
      example: p.def.example ?? null,
    }));
  }

  get(name: string): LoadedParser | null {
    return this.parsers.get(name) ?? null;
  }

  /** Run one parser over a message; null = "not this message". Unknown
   *  parser is a named error, not an exception. */
  run(
    name: string,
    message: ParserMessage,
    args?: ParserArgs,
  ): { ok: boolean; code?: string; error?: string } {
    const p = this.parsers.get(name);
    if (!p) return { ok: false, error: `#NO PARSER ${name}` };
    try {
      const input =
        p.kind === "sms-parser" && p.def.apiVersion === 2 ? message.body : message;
      const code = p.def.parseMessage(input, args ?? emptyArgs());
      return code === null || code === undefined || code === ""
        ? { ok: false }
        : { ok: true, code: String(code) };
    } catch (err) {
      return {
        ok: false,
        error: `#PARSER ERROR ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}

function emptyArgs(): ParserArgs {
  return { resolverName: "", resolverArgs: [], field: "", site: "other", profile: {} };
}
