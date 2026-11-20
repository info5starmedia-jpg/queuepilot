import { createHash } from "node:crypto";
import { z } from "zod";
import { DEFAULT_PERSONA, SiteSchema, loadPersonas, type Persona, type Site } from "./warmup/persona.js";
import { compilePlan, type PlannedSession } from "./warmup/plan.js";

/**
 * W2 — warmup planning lives on the server. Personas, site lists, each
 * account's site settings and the planner never ship to QueuePilot; a
 * QueuePilot asks for a plan (`POST /warmup/plan`) and gets back only the
 * concrete visits to run, which its local step runner executes through the
 * profile's own proxy.
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

/** Drops excluded hosts from `sites`/`extraSites` and appends the added sites. */
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

/** Swaps each visit's address for the site's `urlByCountry[country]` entry when one exists. */
export function localiseVisits(sessions: PlannedSession[], persona: Persona, country: string): void {
  const cc = country.toUpperCase();
  const sites = [...persona.sites, ...persona.extraSites];
  for (const session of sessions) {
    for (const v of session.visits) {
      const site = sites.find((x) => x.url === v.url || hostKey(x.url) === hostKey(v.url));
      const alt = site?.urlByCountry[cc];
      if (!site || !alt) continue;
      const fromHost = new URL(site.url).hostname;
      v.url = alt;
      // Local stores use different search paths, so a localised visit browses from the homepage.
      if (v.productSearchUrl) {
        try {
          if (new URL(v.productSearchUrl).hostname === fromHost) delete v.productSearchUrl;
        } catch {
          delete v.productSearchUrl;
        }
      }
    }
  }
}

export interface SiteSettingsStore {
  getSiteSettings(accountId: string, personaId: string): unknown | null;
  setSiteSettings(accountId: string, personaId: string, json: string): void;
}

export const PlanRequestSchema = z.object({
  persona: z.string().max(64).optional(),
  sessions: z.number().int().min(1).max(10).default(1),
  /** ISO-2 exit-IP country, measured by QueuePilot. */
  country: z.string().regex(/^[A-Za-z]{2}$/).optional(),
  /** Opaque per-profile reference (QueuePilot sends a hash, never the profile). */
  target: z.string().regex(/^[\w-]{1,64}$/),
});

export class WarmupPlanner {
  constructor(
    private readonly store: SiteSettingsStore,
    private readonly personaDir: string | null,
  ) {}

  private cache: { at: number; personas: Persona[] } | null = null;

  /** Bundled personas, re-read at most every 30 s (not on every request). */
  basePersonas(): Persona[] {
    if (!this.personaDir) return [DEFAULT_PERSONA];
    if (this.cache && Date.now() - this.cache.at < 30_000) return this.cache.personas;
    let personas: Persona[];
    try {
      personas = loadPersonas(this.personaDir);
    } catch {
      personas = [DEFAULT_PERSONA];
    }
    this.cache = { at: Date.now(), personas };
    return personas;
  }

  private base(personaId: string): Persona | null {
    return this.basePersonas().find((p) => p.id === personaId) ?? null;
  }

  siteSettings(accountId: string, personaId: string): SiteSettings {
    const raw = this.store.getSiteSettings(accountId, personaId);
    const parsed = SiteSettingsSchema.safeParse(raw ?? {});
    return parsed.success ? parsed.data : { excluded: [], added: [] };
  }

  /** The account's view of a persona (its site settings applied). */
  persona(accountId: string, personaId: string): Persona | null {
    const p = this.base(personaId);
    return p ? applySiteSettings(p, this.siteSettings(accountId, personaId)) : null;
  }

  personas(accountId: string): { id: string; name: string; description: string | null; sites: number }[] {
    return this.basePersonas().map((p) => {
      const mine = applySiteSettings(p, this.siteSettings(accountId, p.id));
      return { id: p.id, name: p.name, description: p.description || null, sites: mine.sites.length };
    });
  }

  /** Every site the persona ships with (and whether excluded) plus the account's added sites. */
  sites(accountId: string, personaId: string) {
    const p = this.base(personaId);
    if (!p) return null;
    const s = this.siteSettings(accountId, personaId);
    const skip = new Set(s.excluded.map((h) => h.toLowerCase().replace(/^www\./, "")));
    const row = (x: Site, pool: string) => ({ url: x.url, host: hostKey(x.url), category: x.category, pool, excluded: skip.has(hostKey(x.url)) });
    return { sites: [...p.sites.map((x) => row(x, "main")), ...p.extraSites.map((x) => row(x, "extra"))], added: s.added, excluded: s.excluded };
  }

  setSites(accountId: string, personaId: string, input: unknown): SiteSettings | { error: string } | null {
    if (!this.base(personaId)) return null;
    const parsed = SiteSettingsSchema.safeParse(input ?? {});
    if (!parsed.success) return { error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
    this.store.setSiteSettings(accountId, personaId, JSON.stringify(parsed.data));
    return parsed.data;
  }

  /** Compiles an immediate plan for one profile; the visits are all QueuePilot receives. */
  plan(accountId: string, input: unknown): { personaId: string; sessions: PlannedSession[] } | { error: string; status: number } {
    const req = PlanRequestSchema.safeParse(input ?? {});
    if (!req.success) return { status: 400, error: req.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
    const personaId = req.data.persona ?? DEFAULT_PERSONA.id;
    const persona = this.persona(accountId, personaId);
    if (!persona) return { status: 404, error: `unknown persona "${personaId}"` };
    if (persona.sites.length === 0) return { status: 400, error: `every site of persona "${personaId}" is excluded — include or add at least one` };
    // Per account + profile, so two accounts' identical refs don't share plans.
    const targetId = createHash("sha256").update(`${accountId}:${req.data.target}`).digest("hex").slice(0, 16);
    const plan = compilePlan(persona, [{ targetId, kind: "browser" }], { immediate: true, days: 1 });
    const sessions: PlannedSession[] = plan.sessions.slice(0, req.data.sessions);
    if (req.data.country) localiseVisits(sessions, persona, req.data.country);
    return { personaId, sessions };
  }
}
