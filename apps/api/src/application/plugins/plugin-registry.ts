import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { writeFileAtomic } from "../../infrastructure/atomic-write.js";
import { ResolverRegistry } from "../resolvers/resolver-registry.js";
import { ParserRegistry, type ParserDefinition } from "../parsers/parser-registry.js";

/**
 * Plugin registry — Jancy's developer platform, registry-first. A plugin is
 * a folder under `<dataDir>/plugins/<id>/` with `package.json`
 * (`name`, `version`, `main`) and an ESM entry that exports:
 *
 *   export const queuepilotProps = { registryVersion: 1, enabled: true }
 *   export async function onInit(ctx) {}
 *   export async function onEnabled(ctx) {}
 *   export async function onDisabled(ctx) {}
 *
 * The context exposes the registries plugins contribute to — resolvers and
 * parsers today; tab actions, menu entries, web endpoints follow the same
 * shape. Jancy's lesson, kept: registries exist BEFORE the features that
 * fill them.
 *
 * Sandboxing, stated honestly: plugins run in-process with API-level trust
 * (they are local code the operator installed). That is the same trust
 * model as Jancy and every browser extension runtime; do not load plugins
 * you would not run as your own user.
 */

export interface PluginManifest {
  name: string;
  version?: string;
  description?: string;
  main?: string;
}

export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  enabled: boolean;
  loaded: boolean;
  error: string | null;
}

export interface PluginModule {
  queuepilotProps?: { registryVersion?: number; enabled?: boolean };
  onInit?: (ctx: PluginContext) => void | Promise<void>;
  onEnabled?: (ctx: PluginContext) => void | Promise<void>;
  onDisabled?: (ctx: PluginContext) => void | Promise<void>;
}

export interface PluginContext {
  /** Per-plugin JSON store under <dataDir>/plugins/<id>/store.json. */
  store: {
    get(key: string): unknown;
    set(key: string, value: unknown): void;
  };
  resolvers: {
    register(name: string, fn: Parameters<ResolverRegistry["register"]>[1]): void;
  };
  parsers: {
    register(def: ParserDefinition): void;
  };
  log: (line: string) => void;
}

export class PluginRegistry {
  /**
   * Per-store-file write chains (audit GPT-5.4 finding 5b): `store.set` used
   * to be read-modify-write with no lock, so two concurrent sets (two
   * endpoint handlers, a command racing a macro) both read the old file and
   * the second write silently dropped the first key. Serializing each
   * file's writes through a promise chain makes every set see the previous.
   */
  private readonly storeChains = new Map<string, Promise<void>>();
  private readonly plugins = new Map<string, {
    info: PluginInfo;
    module: PluginModule | null;
    dir: string;
    enabledState: boolean; // operator toggle; manifest default on first load
  }>();
  private logs: string[] = [];

  /** Where plugin folders live (<dataDir>/plugins). */
  get dir(): string {
    return this.pluginsDir;
  }

  constructor(
    private readonly pluginsDir: string,
    private readonly resolvers: ResolverRegistry,
    private readonly parsers: ParserRegistry,
  ) {}

  /** Load every plugin folder. Errors are captured per-plugin, never fatal. */
  async rescan(): Promise<{ loaded: number; errors: { id: string; error: string }[] }> {
    this.plugins.clear();
    const errors: { id: string; error: string }[] = [];
    fs.mkdirSync(this.pluginsDir, { recursive: true });
    for (const entry of fs.readdirSync(this.pluginsDir).sort()) {
      // Dot-folders are import staging (B3), never plugins.
      if (entry.startsWith(".")) continue;
      const dir = path.join(this.pluginsDir, entry);
      if (!fs.statSync(dir).isDirectory()) continue;
      await this.loadOrRecord(entry, dir, errors);
    }
    return { loaded: [...this.plugins.values()].filter((p) => p.info.loaded).length, errors };
  }

  /**
   * Register a plugin folder that was just installed (B3 import) without
   * rescanning — and so without re-running any other plugin's onInit.
   */
  async addInstalled(id: string): Promise<PluginInfo> {
    const errors: { id: string; error: string }[] = [];
    await this.loadOrRecord(id, path.join(this.pluginsDir, id), errors);
    return { ...this.plugins.get(id)!.info };
  }

  private async loadOrRecord(id: string, dir: string, errors: { id: string; error: string }[]): Promise<void> {
    try {
      await this.loadOne(id, dir);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      errors.push({ id, error });
      this.plugins.set(id, {
        info: { id, name: id, version: "", enabled: false, loaded: false, error },
        module: null,
        dir,
        enabledState: false,
      });
    }
  }

  /** The operator's persisted toggle, or null when never set. */
  private storedEnabled(dir: string): boolean | null {
    const stateFile = path.join(dir, "enabled.json");
    return fs.existsSync(stateFile)
      ? (JSON.parse(fs.readFileSync(stateFile, "utf8")) as { enabled: boolean }).enabled
      : null;
  }

  private async loadOne(id: string, dir: string): Promise<void> {
    const manifestRaw = JSON.parse(
      fs.readFileSync(path.join(dir, "package.json"), "utf8"),
    ) as PluginManifest;
    // A plugin the operator has switched off is listed but NOT imported: its
    // top-level code and onInit run only once it is enabled (B3 — imported
    // plugins land disabled and must not execute before the owner says so).
    if (this.storedEnabled(dir) === false) {
      this.plugins.set(id, {
        info: { id, name: manifestRaw.name ?? id, version: manifestRaw.version ?? "", enabled: false, loaded: false, error: null },
        module: null,
        dir,
        enabledState: false,
      });
      return;
    }
    const main = manifestRaw.main ?? "index.mjs";
    const mod = (await import(pathToFileURL(path.join(dir, main)).href)) as PluginModule;
    const enabledByDefault = mod.queuepilotProps?.enabled !== false;
    const enabledState = this.storedEnabled(dir) ?? enabledByDefault;
    const info: PluginInfo = {
      id,
      name: manifestRaw.name ?? id,
      version: manifestRaw.version ?? "",
      enabled: enabledState,
      loaded: true,
      error: null,
    };
    this.plugins.set(id, { info, module: mod, dir, enabledState });
    const ctx = this.contextFor(id, dir);
    await mod.onInit?.(ctx);
    if (enabledState) await mod.onEnabled?.(ctx);
  }

  private contextFor(id: string, dir: string): PluginContext {
    const storeFile = path.join(dir, "store.json");
    const readStore = (): Record<string, unknown> => {
      try {
        return JSON.parse(fs.readFileSync(storeFile, "utf8"));
      } catch {
        return {};
      }
    };
    return {
      store: {
        get: (key) => readStore()[key],
        set: (key, value) => {
          // Enqueue on the file's write chain so concurrent sets serialize
          // (5b). Errors are captured into the chain's log instead of
          // surfacing as unhandled rejections — plugin stores are
          // best-effort persistence.
          const prev = this.storeChains.get(storeFile) ?? Promise.resolve();
          const next = prev.then(() => {
            const all = readStore();
            all[key] = value;
            writeFileAtomic(storeFile, JSON.stringify(all, null, 2));
          });
          this.storeChains.set(
            storeFile,
            next.catch((err) => {
              this.logs.push(
                `[${id}] store write failed: ${err instanceof Error ? err.message : String(err)}`,
              );
              if (this.logs.length > 500) this.logs.shift();
            }),
          );
        },
      },
      resolvers: {
        register: (name, fn) => this.resolvers.register(`plugin.${id}.${name}`, fn),
      },
      parsers: {
        register: (def) =>
          this.parsers.register(def, `plugin:${id}`, path.join(dir, "plugin")),
      },
      log: (line) => {
        this.logs.push(`[${id}] ${line}`);
        if (this.logs.length > 500) this.logs.shift();
      },
    };
  }

  list(): PluginInfo[] {
    return [...this.plugins.values()].map((p) => ({ ...p.info }));
  }

  recentLogs(): string[] {
    return [...this.logs];
  }

  /** Toggle a loaded plugin's enabled state (persists to enabled.json).
   *  Contribution contract: plugins register resolvers/parsers inside
   *  onEnabled; disabling unregisters them immediately. */
  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const p = this.plugins.get(id);
    if (!p) throw new Error(`#NO PLUGIN ${id}`);
    p.enabledState = enabled;
    p.info.enabled = enabled;
    fs.writeFileSync(
      path.join(p.dir, "enabled.json"),
      JSON.stringify({ enabled }, null, 2),
    );
    // First enable of a never-imported plugin: import it now (onInit +
    // onEnabled run inside loadOne). A broken plugin is recorded, and the
    // toggle reverts so it is not retried on every rescan.
    if (enabled && !p.module) {
      const errors: { id: string; error: string }[] = [];
      await this.loadOrRecord(id, p.dir, errors);
      if (errors.length) {
        fs.writeFileSync(path.join(p.dir, "enabled.json"), JSON.stringify({ enabled: false }, null, 2));
        throw new Error(`plugin ${id} failed to load: ${errors[0]!.error}`);
      }
      return;
    }
    if (!enabled) {
      this.resolvers.unregisterByPrefix(`plugin.${id}.`);
      this.parsers.unregisterBySource(`plugin:${id}`);
    }
    const ctx = this.contextFor(id, p.dir);
    if (enabled) await p.module?.onEnabled?.(ctx);
    else await p.module?.onDisabled?.(ctx);
  }
}
