import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * JYL adoption — user commands and macros as `.mjs` modules in
 * `<dataDir>/jyl/`, Jancy's "users write their own tooling without waiting
 * for a release" idea. Parsers already have their own registry (P7 item 2);
 * this is the command/macro half. Web endpoints and settings bundles are
 * deliberately deferred (documented in parity-jancy.md).
 *
 * A module looks like:
 *
 *   export const queuepilotJyl = {
 *     commands: [{
 *       name: "greet",
 *       description: "say hi",
 *       async run(ctx, args) { ctx.log("hi", args); return "done"; },
 *     }],
 *     macros: [{
 *       name: "onboard",
 *       description: "run greet then tickle",
 *       steps: [{ command: "greet", args: "world" }, { command: "tickle" }],
 *     }],
 *   };
 *
 * - `run(ctx, args)` may return any JSON-able value; it becomes the result.
 * - ctx: { args, profileId?, log, store, fetch } — store is per-module JSON
 *   persistence (same shape as plugin stores), fetch is plain global fetch.
 * - Macro steps run in order; a failing step stops the macro and the error
 *   carries the step index. `{args}` in a step's args is replaced by the
 *   macro's own arguments.
 *
 * Trust model: user code executes in-process with the API's privileges —
 * exactly Jancy's and our plugins' model. Only the operator (who already
 * owns the data dir) can drop files there; docs say so explicitly.
 */

export interface JylCommand {
  name: string;
  description: string;
  run: (ctx: JylContext, args: string) => Promise<unknown> | unknown;
  /** Which module file defined it (for errors and listing). */
  source: string;
}

export interface JylMacroStep {
  command: string;
  args?: string | undefined;
}

export interface JylMacro {
  name: string;
  description: string;
  steps: JylMacroStep[];
  source: string;
}

export interface JylContext {
  args: string;
  profileId?: string | undefined;
  log: (...parts: unknown[]) => void;
  /** Per-module JSON persistence. */
  store: {
    get<T = unknown>(key: string, fallback: T): T;
    set(key: string, value: unknown): void;
  };
  fetch: typeof fetch;
}

interface JylModuleShape {
  commands?: Array<{
    name?: unknown;
    description?: unknown;
    run?: unknown;
  }>;
  macros?: Array<{
    name?: unknown;
    description?: unknown;
    steps?: unknown;
  }>;
}

export interface JylScanResult {
  loaded: number;
  errors: { file: string; error: string }[];
}

export interface JylRunResult {
  ok: boolean;
  result?: unknown;
  error?: string;
  /** Macro runs only: per-step outcomes. */
  steps?: { index: number; command: string; ok: boolean; result?: unknown; error?: string | undefined }[];
}

const COMMAND_TIMEOUT_MS = 30_000;
const MACRO_TIMEOUT_MS = 5 * 60_000;

export class JylRegistry {
  private readonly commands = new Map<string, JylCommand>();
  private readonly macros = new Map<string, JylMacro>();
  private readonly logs: { time: string; module: string; parts: string }[] = [];
  /** module source file -> JSON store backing. */
  private readonly stores = new Map<string, Record<string, unknown>>();

  constructor(private readonly jylDir: string) {}

  async rescan(): Promise<JylScanResult> {
    this.commands.clear();
    this.macros.clear();
    const result: JylScanResult = { loaded: 0, errors: [] };
    if (!fs.existsSync(this.jylDir)) return result;
    for (const file of fs.readdirSync(this.jylDir).filter((f) => f.endsWith(".mjs")).sort()) {
      const full = path.join(this.jylDir, file);
      try {
        const mod = (await import(pathToFileURL(full).href)) as {
          queuepilotJyl?: JylModuleShape;
        };
        const def = mod.queuepilotJyl;
        if (!def || typeof def !== "object") {
          throw new Error("module must export `queuepilotJyl = {commands?, macros?}`");
        }
        for (const c of def.commands ?? []) {
          if (typeof c.name !== "string" || typeof c.run !== "function") {
            throw new Error(`command entries need string name + function run (got ${JSON.stringify(c.name ?? "?")})`);
          }
          const name = c.name;
          if (this.commands.has(name)) {
            throw new Error(`command "${name}" is already defined (duplicate across modules)`);
          }
          this.commands.set(name, {
            name,
            description: typeof c.description === "string" ? c.description : "",
            run: c.run as JylCommand["run"],
            source: file,
          });
        }
        for (const m of def.macros ?? []) {
          if (typeof m.name !== "string" || !Array.isArray(m.steps)) {
            throw new Error(`macro entries need string name + steps[] (got ${JSON.stringify(m.name ?? "?")})`);
          }
          const steps: JylMacroStep[] = m.steps.map((s): JylMacroStep => {
            if (typeof s === "string") return { command: s };
            if (s && typeof s === "object" && typeof (s as JylMacroStep).command === "string") {
              return { command: (s as JylMacroStep).command, args: (s as JylMacroStep).args };
            }
            throw new Error(`macro "${m.name}" has a step that is not a command name or {command, args}`);
          });
          if (this.macros.has(m.name)) {
            throw new Error(`macro "${m.name}" is already defined (duplicate across modules)`);
          }
          this.macros.set(m.name, {
            name: m.name,
            description: typeof m.description === "string" ? m.description : "",
            steps,
            source: file,
          });
        }
        result.loaded++;
      } catch (err) {
        result.errors.push({ file, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return result;
  }

  list(): { commands: { name: string; description: string; source: string }[]; macros: { name: string; description: string; steps: number; source: string }[] } {
    return {
      commands: [...this.commands.values()].map((c) => ({
        name: c.name,
        description: c.description,
        source: c.source,
      })),
      macros: [...this.macros.values()].map((m) => ({
        name: m.name,
        description: m.description,
        steps: m.steps.length,
        source: m.source,
      })),
    };
  }

  recentLogs(limit = 50): typeof this.logs {
    return this.logs.slice(-limit);
  }

  async runCommand(
    name: string,
    args: string,
    ctx: { profileId?: string | undefined },
  ): Promise<JylRunResult> {
    const cmd = this.commands.get(name);
    if (!cmd) return { ok: false, error: `#NO COMMAND ${name}` };
    const jylCtx = this.makeContext(cmd.source, args, ctx.profileId);
    try {
      const result = await withTimeout(
        Promise.resolve(cmd.run(jylCtx, args)),
        COMMAND_TIMEOUT_MS,
        `command "${name}" timed out after ${COMMAND_TIMEOUT_MS / 1000}s`,
      );
      return { ok: true, result: jsonable(result) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async runMacro(
    name: string,
    args: string,
    ctx: { profileId?: string | undefined },
  ): Promise<JylRunResult> {
    const macro = this.macros.get(name);
    if (!macro) return { ok: false, error: `#NO MACRO ${name}` };
    const started = Date.now();
    const steps: NonNullable<JylRunResult["steps"]> = [];
    for (let i = 0; i < macro.steps.length; i++) {
      if (Date.now() - started > MACRO_TIMEOUT_MS) {
        steps.push({ index: i, command: macro.steps[i]!.command, ok: false, error: `macro timed out after ${MACRO_TIMEOUT_MS / 1000}s` });
        return { ok: false, error: "macro timed out", steps };
      }
      const step = macro.steps[i]!;
      const stepArgs = (step.args ?? "").replaceAll("{args}", args);
      const r = await this.runCommand(step.command, stepArgs, ctx);
      steps.push({ index: i, command: step.command, ok: r.ok, result: r.result, error: r.error });
      if (!r.ok) {
        return { ok: false, error: `step ${i} (${step.command}) failed: ${r.error}`, steps };
      }
    }
    return { ok: true, result: { steps: steps.length }, steps };
  }

  private makeContext(source: string, args: string, profileId: string | undefined): JylContext {
    let backing = this.stores.get(source);
    if (!backing) {
      backing = {};
      this.stores.set(source, backing);
    }
    const logs = this.logs;
    return {
      args,
      profileId,
      log: (...parts: unknown[]) => {
        logs.push({ time: new Date().toISOString(), module: source, parts: parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ") });
        if (logs.length > 200) logs.splice(0, logs.length - 200);
      },
      store: {
        get: <T,>(key: string, fallback: T): T =>
          key in backing! ? (backing![key] as T) : fallback,
        set: (key: string, value: unknown) => {
          backing![key] = value;
        },
      },
      fetch,
    };
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let t: NodeJS.Timeout;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        t = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(t!);
  }
}

/** Keep results serializable — user returns whatever; the API answers JSON. */
function jsonable(v: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(v ?? null));
  } catch {
    return String(v);
  }
}
