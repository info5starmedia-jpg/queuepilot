import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { DomainError, ErrorCodes } from "@queuepilot/contracts";
import type { BrowserLifecycleService } from "../lifecycle/browser.lifecycle.service.js";
import { createLogger } from "./persona/core/logger.js";
import { CdpDriver } from "./persona/driver/cdp.js";
import type { Driver } from "./persona/driver/Driver.js";
import { runSession, type SessionResult } from "./persona/warmup/engine.js";
import { DEFAULT_PERSONA, SiteSchema, isPublicWebUrl, loadPersonas, type Persona, type Site } from "./persona/warmup/persona.js";
import { compilePlan } from "./persona/warmup/plan.js";

/**
 * W — the owner's Multilogin warmup engine (C:\multilogin\mlxwarmup\mlx-warmup,
 * vendored under ./persona) running on QueuePilot profiles. Per visit:
 * Google-search arrival when possible → accept the cookie banner → log-normal
 * dwell → scroll bursts → 1–3 same-site clicks; never logs in, never adds to
 * cart, never fills forms. Personas are the engine's own JSON files.
 *
 * QueuePilot owns the lifecycle: a profile that isn't running is started
 * (and stopped again afterwards unless `keepRunning`), and the engine
 * attaches to that run's CDP port. Proxy auth is handled by QueuePilot's
 * relay, so the driver needs no proxy credentials. The record/replay recipes
 * in WarmupService remain the second warmup mode.
 */

export interface PersonaWarmupStatus {
  profileId: string;
  persona: string;
  state: "running" | "done" | "failed" | "stopped";
  sessionsPlanned: number;
  sessionsDone: number;
  visits: number;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  results: { visits: number; aborted: boolean; score: SessionResult["score"] }[];
}

export interface PersonaWarmupDeps {
  lifecycle: BrowserLifecycleService;
  /** Directories with persona JSON files (later wins on id clash). */
  personaDirs: string[];
  /** Tests inject a fake driver and an instant sleep. */
  driverFactory?: (browserUrl: string) => Promise<Driver> | Driver;
  sleep?: (ms: number) => Promise<void>;
  /**
   * ISO-2 country of the profile's exit IP (null = unknown). Sites with a
   * matching `urlByCountry` entry are visited at that address, so country
   * splash screens (bestbuy.com → "Choose a country") never appear.
   */
  exitCountry?: (profileId: string) => Promise<string | null>;
  /** JSON file holding the operator's per-persona site settings (absent = none, read-only). */
  siteSettingsFile?: string;
  /**
   * W2: the team server's warmup planner, when a team server is configured.
   * Then personas, site settings and plans all come from the server and the
   * local planner is not used.
   */
  remote?: () => RemoteWarmup | null;
}

/** What the team server offers (implemented by TeamServerClient). */
export interface RemoteWarmup {
  warmupPersonas(): Promise<PersonaSummary[]>;
  warmupSites(personaId: string): Promise<SitesView>;
  putWarmupSites(personaId: string, body: unknown): Promise<SiteSettings>;
  warmupPlan(req: { persona?: string; sessions: number; country?: string; target: string }): Promise<{ personaId: string; sessions: PlannedSession[] }>;
}

export interface PersonaSummary {
  id: string;
  name: string;
  description: string | null;
  sites: number;
}

export interface SitesView {
  sites: { url: string; host: string; category: string; pool: string; excluded: boolean }[];
  added: unknown[];
  excluded: string[];
}

type PlannedSession = ReturnType<typeof compilePlan>["sessions"][number];

/**
 * Operator site settings per persona: hostnames to skip (from the persona's
 * own lists) and extra sites to add. Stored locally for now; W2 moves them
 * to the server with the plans.
 */
export const SiteSettingsSchema = z.object({
  excluded: z.array(z.string().min(1).max(253).regex(/^[a-z0-9.-]+$/i, "a hostname such as www.example.com")).max(500).default([]),
  added: z.array(SiteSchema).max(100).default([]),
});
export type SiteSettings = z.infer<typeof SiteSettingsSchema>;

function hostKey(u: string): string {
  try {
    return new URL(u).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Drops excluded hosts from `sites`/`extraSites` and appends the added sites. Exported for tests. */
export function applySiteSettings(p: Persona, s: SiteSettings | undefined): Persona {
  if (!s) return p;
  const skip = new Set(s.excluded.map((h) => h.toLowerCase().replace(/^www\./, "")));
  // One entry per host (security audit 2026-11-19): duplicates in `added` or
  // between lists are dropped, so the planner never sees the same site twice.
  const seen = new Set<string>();
  const keep = (x: Site) => {
    const h = hostKey(x.url);
    if (!h || skip.has(h) || seen.has(h)) return false;
    seen.add(h);
    return true;
  };
  const sites = [...p.sites, ...s.added].filter(keep);
  return { ...p, sites, extraSites: p.extraSites.filter(keep) };
}

export class PersonaWarmupService {
  private readonly status = new Map<string, PersonaWarmupStatus>();
  /** Profiles whose running warmup the operator asked to stop. */
  private readonly cancelled = new Set<string>();
  private readonly drivers = new Map<string, Driver>();

  constructor(private readonly deps: PersonaWarmupDeps) {}

  /** Personas as shipped (no operator site settings applied). */
  basePersonas(): Persona[] {
    const byId = new Map<string, Persona>([[DEFAULT_PERSONA.id, DEFAULT_PERSONA]]);
    for (const dir of this.deps.personaDirs) {
      try {
        for (const p of loadPersonas(dir)) byId.set(p.id, p);
      } catch {
        /* a missing or broken dir must not hide the others */
      }
    }
    return [...byId.values()];
  }

  /** Personas with the operator's site settings applied (what a warmup runs). */
  personas(): Persona[] {
    const all = this.readSiteSettings();
    return this.basePersonas().map((p) => applySiteSettings(p, all[p.id]));
  }

  siteSettings(personaId: string): SiteSettings {
    if (!this.basePersonas().some((p) => p.id === personaId)) {
      throw new DomainError(ErrorCodes.VALIDATION_FAILED, `unknown persona "${personaId}"`);
    }
    return this.readSiteSettings()[personaId] ?? { excluded: [], added: [] };
  }

  /** Replaces a persona's include/exclude list and added sites. */
  setSiteSettings(personaId: string, input: unknown): SiteSettings {
    this.siteSettings(personaId); // existence check
    const parsed = SiteSettingsSchema.safeParse(input);
    if (!parsed.success) {
      throw new DomainError(ErrorCodes.VALIDATION_FAILED, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    }
    const file = this.deps.siteSettingsFile;
    if (!file) throw new DomainError(ErrorCodes.VALIDATION_FAILED, "site settings are not writable here");
    const all = this.readSiteSettings();
    all[personaId] = parsed.data;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2), "utf8");
    fs.renameSync(tmp, file);
    return parsed.data;
  }

  private readSiteSettings(): Record<string, SiteSettings> {
    const file = this.deps.siteSettingsFile;
    if (!file || !fs.existsSync(file)) return {};
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
      const out: Record<string, SiteSettings> = {};
      for (const [id, v] of Object.entries(raw)) {
        const s = SiteSettingsSchema.safeParse(v);
        if (s.success) out[id] = s.data;
      }
      return out;
    } catch {
      return {};
    }
  }

  // ---- what the console uses: remote (team server) when configured, else local ----

  async listPersonas(): Promise<PersonaSummary[]> {
    const remote = this.deps.remote?.();
    if (remote) return remote.warmupPersonas();
    return this.personas().map((p) => ({ id: p.id, name: p.name, description: p.description || null, sites: p.sites.length }));
  }

  async sitesView(personaId: string): Promise<SitesView> {
    const remote = this.deps.remote?.();
    if (remote) return remote.warmupSites(personaId);
    const settings = this.siteSettings(personaId);
    const base = this.basePersonas().find((p) => p.id === personaId)!;
    const skip = new Set(settings.excluded.map((h) => h.toLowerCase().replace(/^www\./, "")));
    const row = (x: Site, pool: string) => ({ url: x.url, host: hostKey(x.url), category: x.category, pool, excluded: skip.has(hostKey(x.url)) });
    return {
      sites: [...base.sites.map((x) => row(x, "main")), ...base.extraSites.map((x) => row(x, "extra"))],
      added: settings.added,
      excluded: settings.excluded,
    };
  }

  async saveSites(personaId: string, body: unknown): Promise<SiteSettings> {
    const remote = this.deps.remote?.();
    if (remote) return remote.putWarmupSites(personaId, body);
    return this.setSiteSettings(personaId, body);
  }

  statusOf(profileId: string): PersonaWarmupStatus | null {
    return this.status.get(profileId) ?? null;
  }

  /**
   * Stop a running warmup: no further session starts and the current one is
   * cut off by dropping the driver. The profile is left as the warmup found
   * it (a profile it started is stopped, unless keepRunning).
   */
  async stop(profileId: string): Promise<PersonaWarmupStatus | null> {
    const st = this.status.get(profileId);
    if (!st || st.state !== "running") return st ?? null;
    this.cancelled.add(profileId);
    try {
      await this.drivers.get(profileId)?.dispose();
    } catch {
      /* the run loop handles whatever this interrupts */
    }
    return st;
  }

  /** Starts a warmup in the background; returns the initial status at once. */
  start(profileId: string, opts: { persona?: string; sessions?: number; keepRunning?: boolean } = {}): PersonaWarmupStatus {
    const current = this.status.get(profileId);
    if (current?.state === "running") {
      throw new DomainError(ErrorCodes.VALIDATION_FAILED, "a persona warmup is already running for this profile");
    }
    const wanted = Math.max(1, Math.min(10, opts.sessions ?? 1));
    const remote = this.deps.remote?.();
    let personaId: string;
    let planned: number;
    let getSessions: (country: string | null) => Promise<PlannedSession[]>;
    if (remote) {
      // W2: the server plans; QueuePilot only learns the visits. The profile
      // is referred to by a hash, never by its id.
      personaId = opts.persona ?? DEFAULT_PERSONA.id;
      planned = wanted;
      const target = createHash("sha256").update(`qp-warmup:${profileId}`).digest("hex").slice(0, 32);
      getSessions = async (country) => {
        const plan = await remote.warmupPlan({ persona: personaId, sessions: wanted, target, ...(country ? { country } : {}) });
        return checkRemotePlan(plan.sessions, wanted);
      };
    } else {
      const persona = this.personas().find((p) => p.id === (opts.persona ?? DEFAULT_PERSONA.id));
      if (!persona) throw new DomainError(ErrorCodes.VALIDATION_FAILED, `unknown persona "${opts.persona}"`);
      if (persona.sites.length === 0) {
        throw new DomainError(ErrorCodes.VALIDATION_FAILED, `every site of persona "${persona.id}" is excluded — include or add at least one`);
      }
      const plan = compilePlan(persona, [{ targetId: profileId, kind: "browser" }], { immediate: true, days: 1 });
      const sessions = plan.sessions.slice(0, wanted);
      personaId = persona.id;
      planned = sessions.length;
      getSessions = async (country) => {
        if (country) localiseVisits(sessions, persona, country);
        return sessions;
      };
    }
    const st: PersonaWarmupStatus = {
      profileId,
      persona: personaId,
      state: "running",
      sessionsPlanned: planned,
      sessionsDone: 0,
      visits: 0,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      error: null,
      results: [],
    };
    this.status.delete(profileId);
    this.status.set(profileId, st);
    // Bounded: drop the oldest finished entries (Map keeps insertion order).
    for (const [id, s] of this.status) {
      if (this.status.size <= 500) break;
      if (s.state !== "running") this.status.delete(id);
    }
    void this.run(profileId, st, opts.keepRunning ?? false, getSessions);
    return st;
  }

  private async run(
    profileId: string,
    st: PersonaWarmupStatus,
    keepRunning: boolean,
    getSessions: (country: string | null) => Promise<PlannedSession[]>,
  ): Promise<void> {
    const { lifecycle } = this.deps;
    const wasRunning = lifecycle.activeRun(profileId) !== null;
    let driver: Driver | null = null;
    try {
      const run = wasRunning ? lifecycle.activeRun(profileId)! : await lifecycle.start(profileId);
      if (!run.debugPort && !this.deps.driverFactory) throw new Error("the running profile exposes no debug port");
      const browserUrl = `http://127.0.0.1:${run.debugPort}`;
      const country = (await this.deps.exitCountry?.(profileId).catch(() => null)) ?? null;
      const sessions = await getSessions(country);
      st.sessionsPlanned = sessions.length;
      const logger = createLogger({ component: "persona-warmup", profileId });
      driver = this.deps.driverFactory
        ? await this.deps.driverFactory(browserUrl)
        : await CdpDriver.connect({ browserUrl, logger });
      this.drivers.set(profileId, driver);
      for (const session of sessions) {
        if (this.cancelled.has(profileId)) break;
        const r = await runSession(session, driver, {
          logger,
          searchEngine: session.searchEngine,
          ...(this.deps.sleep ? { sleep: (ms: number) => this.deps.sleep!(ms) } : {}),
        });
        st.sessionsDone++;
        st.visits += r.visits.length;
        st.results.push({ visits: r.visits.length, aborted: r.aborted, score: r.score });
      }
      st.state = this.cancelled.has(profileId) ? "stopped" : "done";
    } catch (err) {
      if (this.cancelled.has(profileId)) st.state = "stopped";
      else {
        st.state = "failed";
        st.error = (err instanceof Error ? err.message : String(err)).slice(0, 300);
      }
    } finally {
      this.drivers.delete(profileId);
      this.cancelled.delete(profileId);
      try {
        await driver?.dispose();
      } catch {
        /* detach best-effort */
      }
      if (!wasRunning && !keepRunning) {
        try {
          await lifecycle.stop(profileId);
        } catch {
          /* stop best-effort */
        }
      }
      st.finishedAt = new Date().toISOString();
    }
  }
}

/**
 * Swaps each visit's address (and its store-search host) for the site's
 * `urlByCountry[country]` entry when one exists. Exported for tests.
 */
export function localiseVisits(
  sessions: ReturnType<typeof compilePlan>["sessions"],
  persona: Persona,
  country: string,
): void {
  const cc = country.toUpperCase();
  const sites = [...persona.sites, ...persona.extraSites];
  for (const session of sessions) {
    for (const v of session.visits) {
      const site = sites.find((x) => x.url === v.url || new URL(x.url).hostname === safeHost(v.url));
      const alt = site?.urlByCountry[cc];
      if (!site || !alt) continue;
      const fromHost = new URL(site.url).hostname;
      v.url = alt;
      // Local stores use different search paths (bestbuy.ca ≠ bestbuy.com), so
      // a localised visit browses from the local homepage instead.
      if (v.productSearchUrl && safeHost(v.productSearchUrl) === fromHost) delete v.productSearchUrl;
    }
  }
}

function safeHost(u: string): string | null {
  try {
    return new URL(u).hostname;
  } catch {
    return null;
  }
}

/**
 * A plan from the team server is checked before a browser runs it: every
 * address must be a public http(s) site (never loopback / private ranges,
 * so a hijacked server can't point profiles at this machine's API), dwell
 * and hop counts must be sane, and the size is capped. Exported for tests.
 */
export function checkRemotePlan(sessions: unknown, maxSessions: number): PlannedSession[] {
  if (!Array.isArray(sessions) || sessions.length === 0 || sessions.length > maxSessions) {
    throw new Error("the team server sent an invalid warmup plan (sessions)");
  }
  for (const s of sessions as PlannedSession[]) {
    // The engine opens `${searchEngine}${encodeURIComponent(query)}`, so the
    // engine must end where a query goes ("=" or "/") and the composed
    // address is checked too, not just its parts.
    if (
      !s || !Array.isArray(s.visits) || s.visits.length > 50 ||
      typeof s.searchEngine !== "string" || !isPublicWebUrl(s.searchEngine) || !/[=/]$/.test(s.searchEngine)
    ) {
      throw new Error("the team server sent an invalid warmup plan (session)");
    }
    for (const v of s.visits) {
      const searchOk =
        v && (v.entry === "direct" ||
          (v.entry === "search" && (v.searchQuery === undefined ||
            (typeof v.searchQuery === "string" && v.searchQuery.length <= 100 &&
              isPublicWebUrl(`${s.searchEngine}${encodeURIComponent(v.searchQuery)}`)))));
      const ok =
        searchOk && typeof v.url === "string" && isPublicWebUrl(v.url) &&
        (v.productSearchUrl === undefined || (typeof v.productSearchUrl === "string" && isPublicWebUrl(v.productSearchUrl))) &&
        typeof v.dwellMs === "number" && v.dwellMs > 0 && v.dwellMs <= 3_600_000 &&
        Number.isInteger(v.hops) && v.hops >= 0 && v.hops <= 5;
      if (!ok) throw new Error("the team server sent an invalid warmup plan (visit)");
    }
  }
  return sessions as PlannedSession[];
}

/** Persona dirs: the bundled examples, then the operator's `<dataDir>/personas`. */
export function personaDirsFor(dataDir: string, apiRoot: string): string[] {
  return [path.join(apiRoot, "personas"), path.join(dataDir, "personas")];
}

/**
 * Exit-IP country for persona localisation: the run's measured exit IP
 * (proxied launches record it) or, without a proxy, this machine's own
 * public IP — both looked up with the same keyless geo service QueuePilot
 * uses for proxy tests. Any failure → null (the persona's default URLs).
 */
export async function ipApiCountry(exitIp: string | null, f: typeof fetch = fetch): Promise<string | null> {
  if (exitIp !== null && !/^[0-9a-fA-F:.]{3,45}$/.test(exitIp)) return null;
  try {
    const res = await f(`http://ip-api.com/json/${exitIp ?? ""}?fields=countryCode`, { signal: AbortSignal.timeout(5000) });
    const j = (await res.json()) as { countryCode?: unknown };
    return typeof j.countryCode === "string" && /^[A-Z]{2}$/.test(j.countryCode) ? j.countryCode : null;
  } catch {
    return null;
  }
}
