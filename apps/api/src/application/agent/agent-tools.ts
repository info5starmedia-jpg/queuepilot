import { z, type ZodTypeAny } from "zod";
import { DomainError, ErrorCodes, type Profile, type Proxy } from "@queuepilot/contracts";
import type { ProfileService } from "../profiles/profile.service.js";
import type { ProxyService } from "../proxies/proxy.service.js";
import type { BrowserLifecycleService } from "../lifecycle/browser.lifecycle.service.js";
import type { WarmupService } from "../warmups/warmup.service.js";
import type { PluginRegistry } from "../plugins/plugin-registry.js";
import type { EngineUpdateService } from "../engine/engine-update.service.js";
import type { ToolSpec } from "./provider.js";

/**
 * P9 agent tool catalog. Every tool is EXISTING service surface, called
 * in-process (no HTTP hop) with zod-validated arguments. Three categories:
 *   read        — always allowed
 *   mutate      — allowed (create/update, start/stop, warmups, plugin toggle)
 *   destructive — needs the human's per-action confirmation in the UI
 * Results are built from public fields only and pass scrubSecrets() before
 * the model ever sees them: no proxy passwords or usernames, no cookies, no
 * tokens. Deliberately NOT in the catalog: resolvers (they return one-time
 * codes / alias secrets), cookies, shell/file/network access of any kind.
 */

export type ToolCategory = "read" | "mutate" | "destructive";

export interface AgentTool {
  name: string;
  category: ToolCategory;
  description: string;
  schema: ZodTypeAny;
  /** Human-readable line for chips and confirmation prompts. */
  describe(args: Record<string, unknown>): string;
  run(args: Record<string, unknown>): Promise<unknown>;
}

export interface AgentToolDeps {
  profiles: ProfileService;
  proxies: ProxyService;
  lifecycle: BrowserLifecycleService;
  warmups: WarmupService;
  plugins: PluginRegistry;
  engineUpdate?: EngineUpdateService;
  /** Engine runtime + installed version for app_overview. */
  engineHealth?: { health: () => { runtime?: string; binaryPresent?: boolean; installs?: Array<{ version?: string }> } };
  /** The scripting gate: plugin toggles run plugin code. Throws when closed. */
  assertScriptingEnabled: () => void;
}

const SECRET_KEY = /pass(word)?|secret|token|cookie|credential|username|authorization|api[-_]?key|private/i;

/** Last line of defence: drop secret-named keys and userinfo in URLs. */
export function scrubSecrets(v: unknown): unknown {
  if (typeof v === "string") return v.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1[redacted]@");
  if (Array.isArray(v)) return v.map(scrubSecrets);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      if (SECRET_KEY.test(k)) continue;
      out[k] = scrubSecrets(val);
    }
    return out;
  }
  return v;
}

// ---------------------------------------------------------------- lookups

function findProfile(profiles: ProfileService, ref: string): Profile {
  const all = profiles.list();
  const hit = all.find((p) => p.id === ref) ?? all.find((p) => p.name.toLowerCase() === ref.toLowerCase());
  if (hit) return hit;
  const near = all.filter((p) => p.name.toLowerCase().includes(ref.toLowerCase())).slice(0, 5).map((p) => p.name);
  throw new DomainError(
    ErrorCodes.PROFILE_NOT_FOUND,
    `no profile named "${ref}"${near.length ? ` — did you mean: ${near.join(", ")}?` : ""}`,
  );
}

function findProxy(proxies: ProxyService, ref: string): Proxy {
  const all = proxies.list();
  const hit =
    all.find((p) => p.id === ref) ??
    all.find((p) => p.name.toLowerCase() === ref.toLowerCase()) ??
    all.find((p) => `${p.host}:${p.port}` === ref);
  if (hit) return hit;
  throw new DomainError(ErrorCodes.PROXY_NOT_FOUND, `no proxy named "${ref}"`);
}

const profileSummary = (p: Profile, proxies: ProxyService) => ({
  name: p.name,
  group: p.group,
  status: p.status,
  proxy: p.proxyId ? (proxies.list().find((x) => x.id === p.proxyId)?.name ?? "(attached)") : null,
  tags: p.tags,
  notes: p.notes ? p.notes.slice(0, 200) : "",
});

const proxySummary = (p: Proxy) => ({
  name: p.name,
  group: p.group,
  type: p.type,
  endpoint: `${p.host}:${p.port}`,
  timezone: p.timezone,
});

// ---------------------------------------------------------------- catalog

const ProfileRef = z.string().min(1).max(200).describe("profile name (or id)");
const ProxyRef = z.string().min(1).max(200).describe("proxy name, host:port, or id");

export function buildAgentTools(d: AgentToolDeps): AgentTool[] {
  const tools: AgentTool[] = [
    // ------------------------------------------------------------ read
    {
      name: "app_overview",
      category: "read",
      description:
        "A snapshot of this QueuePilot install in one call: how many profiles (and how many are running right now), how many proxies and proxy groups, how many warmup recipes and plugins, and which browser engine is installed. Use this FIRST for any 'how many' or 'what do I have' question.",
      schema: z.object({}).strict(),
      describe: () => "reading the app overview",
      run: async () => {
        const profiles = d.profiles.list({});
        const running = profiles.filter((p) => d.lifecycle.activeRun(p.id) !== null);
        const proxies = d.proxies.list();
        const engine = d.engineHealth?.health?.();
        return {
          profiles: {
            total: profiles.length,
            running: running.length,
            runningNames: running.slice(0, 20).map((p) => p.name),
            byStatus: profiles.reduce<Record<string, number>>((acc, p) => {
              const s = String(p.status ?? "idle");
              acc[s] = (acc[s] ?? 0) + 1;
              return acc;
            }, {}),
          },
          proxies: { total: proxies.length, distinctProxyGroups: new Set(proxies.map((p) => p.group ?? "default")).size },
          warmupRecipes: d.warmups.list().length,
          plugins: d.plugins.list().length,
          engine: engine
            ? { runtime: engine.runtime ?? null, installed: engine.binaryPresent ?? false, version: engine.installs?.[0]?.version ?? null }
            : null,
        };
      },
    },
    {
      name: "list_profiles",
      category: "read",
      description: "List browser profiles with their group, status (idle/running/error) and proxy. Optional filters: group, search text.",
      schema: z.object({ group: z.string().max(120).optional(), search: z.string().max(120).optional() }).strict(),
      describe: (a) => `listing profiles${a.group ? ` in ${a.group}` : ""}`,
      run: async (a) => {
        const list = d.profiles.list({
          ...(a.group ? { group: a.group as string } : {}),
          ...(a.search ? { query: a.search as string } : {}),
        });
        return { count: list.length, profiles: list.slice(0, 100).map((p) => profileSummary(p, d.proxies)) };
      },
    },
    {
      name: "get_profile",
      category: "read",
      description: "Details of one profile: group, status, proxy, tags, notes, and its latest run.",
      schema: z.object({ profile: ProfileRef }).strict(),
      describe: (a) => `reading profile ${a.profile}`,
      run: async (a) => {
        const p = findProfile(d.profiles, a.profile as string);
        const run = d.lifecycle.activeRun(p.id);
        return { ...profileSummary(p, d.proxies), run: run ? { status: run.status, startedAt: run.startedAt } : null };
      },
    },
    {
      name: "list_proxies",
      category: "read",
      description: "List proxies (name, group, type, host:port, timezone). Never includes credentials.",
      schema: z.object({ group: z.string().max(120).optional() }).strict(),
      describe: (a) => `listing proxies${a.group ? ` in ${a.group}` : ""}`,
      run: async (a) => {
        const list = d.proxies.list(a.group as string | undefined);
        return { count: list.length, proxies: list.slice(0, 200).map(proxySummary) };
      },
    },
    {
      name: "list_proxy_groups",
      category: "read",
      description: "Proxy groups with how many proxies each has and how many are attached to profiles.",
      schema: z.object({}).strict(),
      describe: () => "listing proxy groups",
      run: async () => ({ groups: d.proxies.groups() }),
    },
    {
      name: "proxy_health",
      category: "read",
      description:
        "Latest health check of every proxy (or one), ranked worst first: failing, then slowest, then never tested. Use this to answer which proxies are unhealthy. It does not run new tests.",
      schema: z.object({ proxy: ProxyRef.optional() }).strict(),
      describe: (a) => `reading proxy health${a.proxy ? ` for ${a.proxy}` : ""}`,
      run: async (a) => {
        const list = a.proxy ? [findProxy(d.proxies, a.proxy as string)] : d.proxies.list();
        const rows = list.map((p) => {
          const last = d.proxies.healthHistory(p.id, 1)[0];
          return {
            name: p.name,
            endpoint: `${p.host}:${p.port}`,
            lastCheck: last
              ? { at: last.checkedAt, ok: last.ok, latencyMs: last.latencyMs, error: last.error, exitIp: last.exitIp }
              : null,
          };
        });
        const rank = (r: (typeof rows)[number]) => (r.lastCheck ? (r.lastCheck.ok ? 1 : 0) : 2);
        rows.sort((x, y) => rank(x) - rank(y) || (y.lastCheck?.latencyMs ?? 0) - (x.lastCheck?.latencyMs ?? 0));
        return { count: rows.length, worstFirst: rows.slice(0, 50) };
      },
    },
    {
      name: "list_warmups",
      category: "read",
      description: "List recorded warmup recipes (name and number of steps).",
      schema: z.object({}).strict(),
      describe: () => "listing warmups",
      run: async () => ({ warmups: d.warmups.list().map((w) => ({ name: w.name, steps: w.steps.length })) }),
    },
    {
      name: "list_plugins",
      category: "read",
      description: "List installed plugins with enabled/loaded state.",
      schema: z.object({}).strict(),
      describe: () => "listing plugins",
      run: async () => ({ plugins: d.plugins.list().map((p) => ({ id: p.id, version: p.version, enabled: p.enabled, loaded: p.loaded, error: p.error })) }),
    },
    {
      name: "list_tabs",
      category: "read",
      description: "List the open tabs (URLs) of a running profile.",
      schema: z.object({ profile: ProfileRef }).strict(),
      describe: (a) => `listing tabs of ${a.profile}`,
      run: async (a) => {
        const p = findProfile(d.profiles, a.profile as string);
        const { tabs } = d.lifecycle.listTabs(p.id);
        return { profile: p.name, running: d.lifecycle.activeRun(p.id) !== null, tabs: tabs.filter((t) => t.status === "open").slice(0, 50).map((t) => ({ url: t.url })) };
      },
    },
    {
      name: "engine_update_status",
      category: "read",
      description: "Whether a newer browser engine is available. Reading only — installing needs the operator's confirmation.",
      schema: z.object({}).strict(),
      describe: () => "checking for an engine update",
      run: async () => {
        if (!d.engineUpdate) return { status: "unavailable" };
        const r = await d.engineUpdate.check();
        return { status: r.status, latest: r.latest ? { version: r.latest.version } : null, error: r.error, installing: r.job?.state === "running" };
      },
    },
    {
      name: "egress_diagnostics",
      category: "read",
      description: "For a running profile: the exit IP and timezone it launched with, and whether its proxy relay is healthy.",
      schema: z.object({ profile: ProfileRef }).strict(),
      describe: (a) => `checking egress of ${a.profile}`,
      run: async (a) => {
        const p = findProfile(d.profiles, a.profile as string);
        return { profile: p.name, ...(d.lifecycle.egressDiagnostics(p.id) as object) };
      },
    },
    // ------------------------------------------------------------ mutate
    {
      name: "create_profile",
      category: "mutate",
      description: "Create a new browser profile with a fresh fingerprint. Optional: group, proxy (by name), notes, tags.",
      schema: z
        .object({
          name: z.string().min(1).max(120),
          group: z.string().min(1).max(120).optional(),
          proxy: ProxyRef.optional(),
          notes: z.string().max(4000).optional(),
          tags: z.array(z.string().min(1).max(60)).max(24).optional(),
        })
        .strict(),
      describe: (a) => `creating profile ${a.name}${a.group ? ` in ${a.group}` : ""}`,
      run: async (a) => {
        if (d.profiles.list().some((p) => p.name.toLowerCase() === String(a.name).toLowerCase())) {
          throw new DomainError(ErrorCodes.CONFLICT, `a profile named "${a.name}" already exists`);
        }
        const proxyId = a.proxy ? findProxy(d.proxies, a.proxy as string).id : undefined;
        const p = d.profiles.create({
          name: a.name as string,
          group: a.group as string | undefined,
          proxyId,
          notes: a.notes as string | undefined,
          tags: a.tags as string[] | undefined,
          generateFingerprint: true,
        });
        return { created: profileSummary(p, d.proxies) };
      },
    },
    {
      name: "update_profile",
      category: "mutate",
      description: "Change a profile's name, group, notes or tags.",
      schema: z
        .object({
          profile: ProfileRef,
          name: z.string().min(1).max(120).optional(),
          group: z.string().min(1).max(120).optional(),
          notes: z.string().max(4000).optional(),
          tags: z.array(z.string().min(1).max(60)).max(24).optional(),
        })
        .strict(),
      describe: (a) => `updating profile ${a.profile}`,
      run: async (a) => {
        const p = findProfile(d.profiles, a.profile as string);
        const { profile: _ref, ...fields } = a;
        if (Object.keys(fields).length === 0) throw new DomainError(ErrorCodes.VALIDATION_FAILED, "nothing to change");
        return { updated: profileSummary(d.profiles.update(p.id, fields), d.proxies) };
      },
    },
    {
      name: "start_profile",
      category: "mutate",
      description: "Launch a profile's browser.",
      schema: z.object({ profile: ProfileRef }).strict(),
      describe: (a) => `starting profile ${a.profile}`,
      run: async (a) => {
        const p = findProfile(d.profiles, a.profile as string);
        const run = await d.lifecycle.start(p.id);
        return { profile: p.name, status: run.status };
      },
    },
    {
      name: "stop_profile",
      category: "mutate",
      description: "Close a running profile's browser.",
      schema: z.object({ profile: ProfileRef }).strict(),
      describe: (a) => `stopping profile ${a.profile}`,
      run: async (a) => {
        const p = findProfile(d.profiles, a.profile as string);
        const run = await d.lifecycle.stop(p.id);
        return { profile: p.name, status: run?.status ?? "not running" };
      },
    },
    {
      name: "test_proxy",
      category: "mutate",
      description: "Run a live test through one proxy now (records a new health check).",
      schema: z.object({ proxy: ProxyRef }).strict(),
      describe: (a) => `testing proxy ${a.proxy}`,
      run: async (a) => {
        const p = findProxy(d.proxies, a.proxy as string);
        const r = await d.proxies.test(p.id);
        return { proxy: p.name, ok: r.ok, latencyMs: r.latencyMs, exitIp: r.exitIp, error: r.error, location: r.geo ? [r.geo.city, r.geo.country].filter(Boolean).join(", ") : null };
      },
    },
    {
      name: "run_warmup",
      category: "mutate",
      description: "Replay a warmup recipe (by name) on a profile; starts the profile if it is idle.",
      schema: z.object({ warmup: z.string().min(1).max(200), profile: ProfileRef, stopAfter: z.boolean().optional() }).strict(),
      describe: (a) => `running warmup ${a.warmup} on ${a.profile}`,
      run: async (a) => {
        const p = findProfile(d.profiles, a.profile as string);
        const recipe = d.warmups.list().find((w) => w.name.toLowerCase() === String(a.warmup).toLowerCase() || w.id === a.warmup);
        if (!recipe) throw new DomainError(ErrorCodes.WARMUP_NOT_FOUND, `no warmup named "${a.warmup}"`);
        const r = await d.warmups.run(recipe.id, p.id, a.stopAfter === undefined ? {} : { stopAfter: a.stopAfter as boolean });
        return { warmup: recipe.name, profile: p.name, steps: r.results.length, failed: r.results.filter((x) => !x.ok).length };
      },
    },
    {
      name: "set_plugin_enabled",
      category: "mutate",
      description: "Turn an installed plugin on or off. Needs scripting endpoints enabled in Settings.",
      schema: z.object({ plugin: z.string().min(1).max(64), enabled: z.boolean() }).strict(),
      describe: (a) => `${a.enabled ? "enabling" : "disabling"} plugin ${a.plugin}`,
      run: async (a) => {
        d.assertScriptingEnabled();
        await d.plugins.setEnabled(a.plugin as string, a.enabled as boolean);
        return { plugin: a.plugin, enabled: a.enabled };
      },
    },
    // ------------------------------------------------------------ destructive
    {
      name: "delete_profile",
      category: "destructive",
      description: "Permanently delete a profile. ALWAYS requires the operator's confirmation in the console before it happens.",
      schema: z.object({ profile: ProfileRef }).strict(),
      describe: (a) => `delete profile ${a.profile} (permanent)`,
      run: async (a) => {
        const p = findProfile(d.profiles, a.profile as string);
        d.profiles.delete(p.id);
        return { deleted: p.name };
      },
    },
    {
      name: "delete_proxy",
      category: "destructive",
      description: "Permanently delete a proxy. ALWAYS requires the operator's confirmation in the console before it happens.",
      schema: z.object({ proxy: ProxyRef }).strict(),
      describe: (a) => `delete proxy ${a.proxy} (permanent)`,
      run: async (a) => {
        const p = findProxy(d.proxies, a.proxy as string);
        d.proxies.delete(p.id);
        return { deleted: p.name };
      },
    },
    {
      name: "install_engine_update",
      category: "destructive",
      description: "Download and install the newest browser engine. ALWAYS requires the operator's confirmation in the console.",
      schema: z.object({}).strict(),
      describe: () => "install the newest browser engine",
      run: async () => {
        if (!d.engineUpdate) throw new DomainError(ErrorCodes.ENGINE_UNAVAILABLE, "engine updates are not available");
        return await d.engineUpdate.start();
      },
    },
  ];
  return tools;
}

/** The catalog as the model sees it (JSON Schema from the zod definitions). */
export function toolSpecs(tools: AgentTool[]): ToolSpec[] {
  return tools.map((t) => ({ name: t.name, description: t.description, parameters: zodToJsonSchema(t.schema) }));
}

/** Minimal zod → JSON Schema for the shapes the catalog uses. */
export function zodToJsonSchema(s: ZodTypeAny): Record<string, unknown> {
  const def = s._def as { typeName: string; description?: string };
  const withDesc = (o: Record<string, unknown>) => (def.description ? { ...o, description: def.description } : o);
  switch (def.typeName) {
    case "ZodObject": {
      const shape = (s as z.ZodObject<z.ZodRawShape>).shape;
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [k, v] of Object.entries(shape)) {
        properties[k] = zodToJsonSchema(v as ZodTypeAny);
        if (!(v as ZodTypeAny).isOptional()) required.push(k);
      }
      return withDesc({ type: "object", properties, required, additionalProperties: false });
    }
    case "ZodOptional":
      return zodToJsonSchema((s as z.ZodOptional<ZodTypeAny>).unwrap());
    case "ZodString":
      return withDesc({ type: "string" });
    case "ZodBoolean":
      return withDesc({ type: "boolean" });
    case "ZodNumber":
      return withDesc({ type: "number" });
    case "ZodArray":
      return withDesc({ type: "array", items: zodToJsonSchema((s as z.ZodArray<ZodTypeAny>).element) });
    default:
      return withDesc({});
  }
}
