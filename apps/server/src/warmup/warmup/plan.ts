// @ts-nocheck -- vendored verbatim from the owner's mlx-warmup (C:/multilogin/mlxwarmup/mlx-warmup); it type-checks under that project's tsconfig. QueuePilot's stricter flags (exactOptionalPropertyTypes, no DOM lib) are not applied to it.
import { Rng } from "../core/random.js";
import { hostOf, registrableDomain } from "../core/url.js";
import { dwellMs, internalHops } from "../driver/humanize.js";
import type { Persona, Site } from "./persona.js";

export type TargetKind = "browser" | "phone";

export interface PlanTarget {
  /** Profile id (browser) or phone id. */
  targetId: string;
  kind: TargetKind;
  /** Browser profiles need their folder too. */
  folderId?: string;
  label?: string;
}

export interface PlannedVisit {
  site: string;
  url: string;
  category: string;
  entry: "search" | "direct";
  searchQuery?: string;
  dwellMs: number;
  hops: number;
  /** For shopping sites: the store's own search-results URL to reach a grid of products. */
  productSearchUrl?: string;
}

export interface PlannedSession {
  id: string;
  targetId: string;
  kind: TargetKind;
  folderId?: string;
  dayIndex: number;
  /** Don't start before this epoch ms — this is what spreads a campaign across days. */
  notBefore: number;
  seed: string;
  /** From the persona — where "search" entries begin. */
  searchEngine: string;
  visits: PlannedVisit[];
  estMs: number;
}

export interface Plan {
  id: string;
  personaId: string;
  seed: string;
  createdAt: number;
  batchSize: number;
  sessions: PlannedSession[];
  summary: {
    targets: number;
    days: number;
    sessions: number;
    visits: number;
    estMinutes: number;
    /** Highest Jaccard overlap between any two targets' adopted site lists — lower is better. */
    maxSiteOverlap: number;
    firstStart: number;
    lastStart: number;
  };
}

export interface CompileOptions {
  seed?: string;
  /** Epoch ms the campaign may begin (default now). */
  startAt?: number;
  batchSize?: number;
  /** Override persona.days. */
  days?: number;
  /** Compress the calendar into one immediate run — for tests and the Phase 0 spike only. */
  immediate?: boolean;
}

/**
 * Turn a persona + targets into a concrete, deterministic list of sessions. Everything
 * random is drawn from the seed, so the same inputs always produce the same plan and a
 * run can be replayed exactly.
 */
export function compilePlan(persona: Persona, targets: PlanTarget[], o: CompileOptions = {}): Plan {
  const seed = o.seed ?? `${persona.id}-${Date.now().toString(36)}`;
  const root = new Rng(seed);
  const startAt = o.startAt ?? Date.now();
  const days = o.immediate ? 1 : (o.days ?? persona.days);
  const sessions: PlannedSession[] = [];
  const adopted = new Map<string, Site[]>();

  for (const t of targets) {
    const trng = root.fork(`target:${t.targetId}`);
    const mine = adoptSites(trng, persona);
    adopted.set(t.targetId, mine);

    for (let day = 0; day < days; day++) {
      if (day > 0 && trng.chance(persona.offDayChance)) continue;
      const n = o.immediate ? 1 : trng.int(persona.sessionsPerDay.min, Math.max(persona.sessionsPerDay.min, persona.sessionsPerDay.max));
      const times = o.immediate ? [startAt] : sessionTimes(trng, persona, startAt, day, n);
      for (let s = 0; s < times.length; s++) {
        const srng = trng.fork(`d${day}s${s}`);
        const visits = buildVisits(srng, persona, mine);
        const estMs = visits.reduce((a, v) => a + v.dwellMs * (1 + v.hops * 0.7) + 12_000, 0);
        sessions.push({
          id: `${t.targetId.slice(0, 8)}-d${day}-s${s}-${srng.int(1000, 9999)}`,
          targetId: t.targetId,
          kind: t.kind,
          folderId: t.folderId,
          dayIndex: day,
          notBefore: times[s]!,
          seed: srng.seed,
          searchEngine: persona.searchEngine,
          visits,
          estMs,
        });
      }
    }
  }

  sessions.sort((a, b) => a.notBefore - b.notBefore || a.targetId.localeCompare(b.targetId));
  const visits = sessions.reduce((a, s) => a + s.visits.length, 0);
  const estMinutes = Math.round(sessions.reduce((a, s) => a + s.estMs, 0) / 60_000);
  return {
    id: `plan-${seed}`,
    personaId: persona.id,
    seed,
    createdAt: Date.now(),
    batchSize: o.batchSize ?? 5,
    sessions,
    summary: {
      targets: targets.length,
      days,
      sessions: sessions.length,
      visits,
      estMinutes,
      maxSiteOverlap: maxJaccard([...adopted.values()].map((l) => new Set(l.map((s) => s.url)))),
      firstStart: sessions[0]?.notBefore ?? startAt,
      lastStart: sessions[sessions.length - 1]?.notBefore ?? startAt,
    },
  };
}

/** Each profile adopts a random subset of the persona's sites so no two share the exact same list. */
function adoptSites(rng: Rng, persona: Persona): Site[] {
  const shuffled = rng.shuffle(persona.sites);
  const n = Math.max(Math.min(3, shuffled.length), Math.round(shuffled.length * rng.float(persona.siteAdoption, 1)));
  const picked = shuffled.slice(0, n);
  // the search engine always stays in the pool — it is the entry point
  const search = persona.sites.find((s) => s.category === "search");
  if (search && !picked.includes(search)) picked.push(search);
  return picked;
}

function buildVisits(rng: Rng, persona: Persona, pool: Site[]): PlannedVisit[] {
  const n = rng.int(persona.sitesPerSession.min, Math.max(persona.sitesPerSession.min, persona.sitesPerSession.max));
  const nonSearch = pool.filter((s) => s.category !== "search");
  const total = persona.entryMix.search + persona.entryMix.direct || 1;
  const used = new Set<string>();
  const toVisit = (site: Site): PlannedVisit => {
    const wantSearch = rng.next() < persona.entryMix.search / total && site.searchTerms.length > 0;
    const isShopping = site.category === "shopping";
    // Shopping is browsing several things: an aisle and an item, or two items compared.
    // One click is not shopping, so shopping visits get a floor of two (or the site's max).
    const hops = isShopping ? Math.max(Math.min(2, site.maxHops), internalHops(rng, site.maxHops)) : internalHops(rng, site.maxHops);
    return {
      site: registrableDomain(hostOf(site.url)),
      url: site.url,
      category: site.category,
      entry: wantSearch ? "search" : "direct",
      searchQuery: wantSearch ? rng.pick(site.searchTerms) : undefined,
      dwellMs: dwellMs(rng, persona.dwell, site.dwellMultiplier),
      hops,
      productSearchUrl: isShopping && site.search ? storeSearchUrl(site, rng) : undefined,
    };
  };
  const out: PlannedVisit[] = [];
  // QueuePilot (security audit 2026-11-19): bound by UNIQUE urls and draw only
  // from unused sites — with duplicate urls the original retry loop never ended.
  for (let i = 0; i < n; i++) {
    const left = nonSearch.filter((s) => !used.has(s.url));
    if (left.length === 0) break;
    const site: Site = rng.weighted(left.map((s) => ({ value: s, weight: s.weight })));
    used.add(site.url);
    out.push(toVisit(site));
  }
  // Rotate in a few extra sites so no two sessions look identical (and the domain footprint grows).
  const extraN = persona.extraSites.length ? rng.int(persona.extrasPerSession.min, Math.max(persona.extrasPerSession.min, persona.extrasPerSession.max)) : 0;
  for (const site of rng.shuffle(persona.extraSites).slice(0, extraN)) {
    if (used.has(site.url)) continue;
    used.add(site.url);
    out.push(toVisit(site));
  }
  // shuffle so the extras aren't always tacked on at the end
  return rng.shuffle(out);
}

/** Build the store's search-results URL for a product query (brand words trimmed off). */
function storeSearchUrl(site: Site, rng: Rng): string {
  const q = onSiteQuery(site, rng);
  return site.search!.replace(/\{q\}/g, encodeURIComponent(q));
}

/** A product query for on-site search: a random search term with leading store-brand words removed. */
function onSiteQuery(site: Site, rng: Rng): string {
  const term = site.searchTerms.length ? rng.pick(site.searchTerms) : "deals";
  const brand = registrableDomain(hostOf(site.url)).split(".")[0] ?? "";
  const words = term.split(/\s+/).filter(Boolean);
  while (words.length > 1 && brand.includes(words[0]!.toLowerCase())) words.shift();
  return words.join(" ");
}

/** n start times on day `day`, inside the persona's active hours in its own timezone, spaced apart. */
function sessionTimes(rng: Rng, persona: Persona, startAt: number, day: number, n: number): number[] {
  const { start, end } = persona.activeHours;
  const span = start < end ? end - start : 24 - start + end;
  const dayAnchor = startAt + day * 86_400_000;
  const ymd = ymdIn(new Date(dayAnchor), persona.timezone);
  const slots: number[] = [];
  // divide the window into n bands and pick a random minute in each, so sessions don't bunch
  for (let i = 0; i < n; i++) {
    const frac = (i + rng.float(0.1, 0.9)) / n;
    const hourOffset = frac * span;
    const h = (start + Math.floor(hourOffset)) % 24;
    const m = Math.floor((hourOffset % 1) * 60);
    let t = zonedToEpoch(ymd.y, ymd.m, ymd.d, h, m, persona.timezone);
    if (day === 0 && t < startAt) t = startAt + rng.int(0, 15) * 60_000; // today: never in the past
    slots.push(t);
  }
  return slots.sort((a, b) => a - b);
}

function ymdIn(date: Date, timeZone: string): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  return { y: get("year"), m: get("month"), d: get("day") };
}

function tzOffsetMs(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return asUtc - date.getTime();
}

/** Local wall-clock time in a zone → epoch ms. */
export function zonedToEpoch(y: number, m: number, d: number, h: number, min: number, timeZone: string): number {
  const guess = Date.UTC(y, m - 1, d, h, min);
  return guess - tzOffsetMs(new Date(guess), timeZone);
}

function maxJaccard(sets: Set<string>[]): number {
  let max = 0;
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      const a = sets[i]!;
      const b = sets[j]!;
      let inter = 0;
      for (const x of a) if (b.has(x)) inter++;
      const union = a.size + b.size - inter;
      if (union > 0) max = Math.max(max, inter / union);
    }
  }
  return Math.round(max * 100) / 100;
}
