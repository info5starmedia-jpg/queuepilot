import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Parser registry — Jancy's `jancy://parsers` as JS modules. A user drops
 * `<name>.mjs` into `<dataDir>/parsers/` (Jancy's `.jyl` on-ramp, same
 * promise: teach the browser to read a new site's 2FA without waiting for a
 * release) and rescans. A parser module exports:
 *
 *   export default {
 *     kind: "email-parser" | "sms-parser",
 *     name: "ticketmaster-v3",
 *     canRun: (account) => boolean,          // optional
 *     getQuery: (account) => string,         // optional: Gmail operators or IMAP search
 *     parseMessage: (message) => string,     // code or null
 *   }
 *
 * `message` is { subject, from, body }. parseMessage returns the code or
 * null — never throws for "this message isn't it", that is what null means.
 */

export interface ParserMessage {
  subject: string;
  from: string;
  body: string;
}

export interface ParserDefinition {
  kind: "email-parser" | "sms-parser";
  name: string;
  canRun?: (account: { email?: string | undefined }) => boolean;
  getQuery?: (account: { email?: string | undefined }) => string;
  parseMessage: (message: ParserMessage) => string | null;
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

  /** Rescan the parsers dir. A file that fails to load is reported, never
   *  fatal — one bad user script must not take down the rest. */
  async rescan(): Promise<{ loaded: number; errors: { file: string; error: string }[] }> {
    this.parsers.clear();
    const errors: { file: string; error: string }[] = [];
    if (!fs.existsSync(this.parsersDir)) return { loaded: 0, errors };
    for (const entry of fs.readdirSync(this.parsersDir).sort()) {
      if (!entry.endsWith(".mjs")) continue;
      const file = path.join(this.parsersDir, entry);
      try {
        const mod = (await import(pathToFileURL(file).href)) as {
          default?: ParserDefinition;
        };
        const def = mod.default;
        if (!def) throw new Error("no default export");
        this.register(def, "user", file);
      } catch (err) {
        errors.push({
          file: entry,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { loaded: this.parsers.size, errors };
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

  list(): { name: string; kind: string; file: string }[] {
    return [...this.parsers.values()].map((p) => ({
      name: p.name,
      kind: p.kind,
      file: path.basename(p.file),
    }));
  }

  get(name: string): LoadedParser | null {
    return this.parsers.get(name) ?? null;
  }

  /** Run one parser over a message; null = "not this message". Unknown
   *  parser is a named error, not an exception. */
  run(name: string, message: ParserMessage): { ok: boolean; code?: string; error?: string } {
    const p = this.parsers.get(name);
    if (!p) return { ok: false, error: `#NO PARSER ${name}` };
    try {
      const code = p.def.parseMessage(message);
      return code === null ? { ok: false } : { ok: true, code };
    } catch (err) {
      return {
        ok: false,
        error: `#PARSER ERROR ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}
