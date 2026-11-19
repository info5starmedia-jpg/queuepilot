import type { Logger } from "../core/logger.js";
import { Rng } from "../core/random.js";
import { sleep as realSleep } from "../core/time.js";
import { hostOf, isCatalogLink, isProductLink, registrableDomain } from "../core/url.js";
import type { Driver, LinkCandidate, StorageSnapshot } from "../driver/Driver.js";
import { betweenSitesMs, longReadMs, pacedMs, readPauseMs, scrollFlick, settleMs } from "../driver/humanize.js";
import type { PlannedSession, PlannedVisit } from "./plan.js";
import { trustScore, type TrustScore } from "./score.js";

export interface VisitRecord {
  site: string;
  url: string;
  entry: "search" | "direct";
  ok: boolean;
  landedUrl?: string;
  hops: number;
  /** Of those hops, how many landed on a real product page. */
  products: number;
  /** …and how many on a department/category page. */
  catalogs: number;
  consent: boolean;
  dwellMs: number;
  error?: string;
  startedAt: number;
  endedAt: number;
}

export interface SessionResult {
  sessionId: string;
  visits: VisitRecord[];
  before: StorageSnapshot;
  after: StorageSnapshot;
  score: TrustScore;
  startedAt: number;
  endedAt: number;
  aborted: boolean;
}

export interface EngineDeps {
  logger: Logger;
  signal?: AbortSignal;
  /** Injectable so tests run instantly. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Hard cap on a session; the plan's estimate is a guide, this is the wall. */
  maxSessionMs?: number;
  onVisit?: (v: VisitRecord) => void;
  /** Where to send "site" visits that begin with a search. */
  searchEngine: string;
}

/**
 * Runs one planned session against a Driver. Deterministic given the session seed;
 * all waiting goes through `deps.sleep`. Never logs in, never buys, never fills forms —
 * it navigates, accepts consent, dwells, scrolls, and follows same-site links.
 */
export async function runSession(session: PlannedSession, driver: Driver, deps: EngineDeps): Promise<SessionResult> {
  const rng = new Rng(session.seed);
  const sleep = deps.sleep ?? realSleep;
  const log = deps.logger.child({ session: session.id, target: session.targetId });
  const startedAt = Date.now();
  const deadline = startedAt + (deps.maxSessionMs ?? 45 * 60_000);
  const aborted = () => Boolean(deps.signal?.aborted) || Date.now() > deadline;

  const before = await driver.snapshotStorage();
  const visits: VisitRecord[] = [];

  for (const visit of session.visits) {
    if (aborted()) break;
    const rec = await doVisit(visit, driver, rng.fork(visit.url), { ...deps, sleep, log });
    visits.push(rec);
    deps.onVisit?.(rec);
    if (aborted()) break;
    // between sites: a breath
    await sleep(betweenSitesMs(rng), deps.signal);
  }

  const after = await driver.snapshotStorage();
  return {
    sessionId: session.id,
    visits,
    before,
    after,
    score: trustScore(before, after),
    startedAt,
    endedAt: Date.now(),
    aborted: Boolean(deps.signal?.aborted),
  };
}

/**
 * The exact text a blocked visit is recorded with. Counting relies on it, so it is matched
 * exactly and never as a substring — Chrome's own ERR_BLOCKED_BY_CLIENT is not a bot wall.
 */
export const BLOCKED_BY_SITE = "the site blocked this visit";
/**
 * Where a bot wall sends you. Worth spotting: a blocked visit looks exactly like a boring
 * one in the numbers, and "it isn't shopping" is a very different problem from "the site
 * won't let this IP shop". Clicking on through a block page is pointless and conspicuous.
 */
const BLOCK_PAGE = /\/(blocked|captcha|px-captcha|challenge|access-?denied|bot-?detection|distil_r_)|\/errors?\/(403|429)/i;

type Ctx = EngineDeps & { sleep: NonNullable<EngineDeps["sleep"]>; log: Logger };

async function doVisit(v: PlannedVisit, d: Driver, rng: Rng, c: Ctx): Promise<VisitRecord> {
  const startedAt = Date.now();
  const rec: VisitRecord = { site: v.site, url: v.url, entry: v.entry, ok: false, hops: 0, products: 0, catalogs: 0, consent: false, dwellMs: v.dwellMs, startedAt, endedAt: startedAt };
  try {
    let landed = false;
    if (v.entry === "search" && v.searchQuery) landed = await viaSearch(v, d, rng, c);
    if (!landed) {
      const nav = await d.goto(v.url);
      if (!nav.ok) {
        rec.error = nav.error ?? `status ${nav.status}`;
        rec.endedAt = Date.now();
        c.log.warn("visit failed", { site: v.site, error: rec.error });
        return rec;
      }
      rec.entry = "direct";
    }
    rec.ok = true;
    rec.landedUrl = await d.currentUrl();
    rec.consent = await d.handleConsent();

    await dwellAndScroll(d, rng, v.dwellMs, c);

    // Shopping: shop like a person — search the store, open real products, look, compare.
    // Everything else: read a few same-site pages deep.
    if (v.category === "shopping" && v.productSearchUrl && v.hops > 0) {
      await browseStore(v, d, rng, c, rec);
    } else {
      await genericHops(v, d, rng, c, rec);
    }
  } catch (e) {
    rec.error = (e as Error).message;
    c.log.warn("visit error", { site: v.site, error: rec.error });
  }
  rec.endedAt = Date.now();
  c.log.info("visit", { site: v.site, entry: rec.entry, ok: rec.ok, hops: rec.hops, products: rec.products, catalogs: rec.catalogs, consent: rec.consent, dwellMs: rec.dwellMs });
  return rec;
}

/**
 * Shop like a person: use the store's own search to reach a grid of products, then click
 * into real product pages, look at each, and go back to compare another — wandering into a
 * department now and then, the way someone browsing actually moves. A homepage alone has
 * almost no product links; this is what makes a shopping profile look real.
 *
 * Whatever happens, the visit clicks something. Product URLs differ at every retailer and
 * the patterns will never match them all, so an unrecognised grid falls back to department
 * links and then to any same-site link rather than ending the visit with nothing opened.
 */
async function browseStore(v: PlannedVisit, d: Driver, rng: Rng, c: Ctx, rec: VisitRecord): Promise<void> {
  const from = await d.currentUrl();
  const nav = await d.goto(v.productSearchUrl!, { referer: from });
  if (!nav.ok) {
    c.log.debug("store search failed → generic browsing", { site: v.site, error: nav.error });
    await genericHops(v, d, rng, c, rec);
    return;
  }
  if (!rec.consent) rec.consent = await d.handleConsent();
  c.log.info("searched the store", { site: v.site, url: v.productSearchUrl });
  // scan the results grid
  await dwellAndScroll(d, rng, Math.round(v.dwellMs * rng.float(0.4, 0.7)), c);

  for (let i = 0; i < v.hops && !c.signal?.aborted; i++) {
    const links = (await d.collectLinks(120)).filter((l) => l.internal && registrableDomain(hostOf(l.href)) === v.site);
    const products = links.filter((l) => isProductLink(l.href));
    const catalogs = links.filter((l) => isCatalogLink(l.href));
    // A shopper opens items, and now and then wanders off into a department instead.
    const intoCatalog = catalogs.length > 0 && (products.length === 0 || (i < v.hops - 1 && rng.chance(0.35)));
    // Ladder: an item, else an aisle, else whatever same-site link is here. Never nothing —
    // no retailer URL grammar is complete, and a miss must not end the visit without a click.
    const pool = intoCatalog ? catalogs : products.length > 0 ? products : links;
    if (pool.length === 0) {
      c.log.debug("no same-site links to open", { site: v.site });
      break;
    }
    const nav2 = await d.click(pickLink(rng, pool), rng);
    if (!nav2.ok) break;
    // Score where we actually landed, not what we meant to click: a phone taps a point on
    // screen and cannot know where it leads until it gets there. Caveat for phones: Chrome's
    // address bar shows the domain alone once a page has loaded, so there is no path to judge
    // and their product count reads 0 even when they did open one. `hops` is the honest
    // measure there; these two counters are meaningful for browser profiles.
    const landed = await d.currentUrl();
    if (BLOCK_PAGE.test(landed)) {
      rec.error ??= BLOCKED_BY_SITE;
      c.log.warn("blocked by the site", { site: v.site, url: landed });
      break; // a wall is not a page browsed, so it is not counted as a hop
    }
    rec.hops++;
    const onProduct = isProductLink(landed);
    if (onProduct) rec.products++;
    else if (isCatalogLink(landed)) rec.catalogs++;
    c.log.info(onProduct ? "opened a product" : "opened a shop page", { site: v.site, url: landed });
    if (!rec.consent) rec.consent = await d.handleConsent();
    await dwellAndScroll(d, rng, Math.round(v.dwellMs * rng.float(0.5, 1.0)), c);
    // Back to the grid to compare another item — but stay on a department page, since its
    // product links are the whole reason for going there.
    if (onProduct && i < v.hops - 1) {
      await d.back();
      await c.sleep(pacedMs(rng, 1_500, 4_500), c.signal);
      await dwellAndScroll(d, rng, Math.round(v.dwellMs * rng.float(0.2, 0.4)), c);
    }
  }
}

/** Read a few same-site pages deep. On a shopping page that already lists products, prefer them. */
async function genericHops(v: PlannedVisit, d: Driver, rng: Rng, c: Ctx, rec: VisitRecord): Promise<void> {
  for (let i = 0; i < v.hops; i++) {
    if (c.signal?.aborted) break;
    const links = (await d.collectLinks()).filter((l) => l.internal && registrableDomain(hostOf(l.href)) === v.site);
    if (links.length === 0) break;
    const shopping = v.category === "shopping";
    const products = shopping ? links.filter((l) => isProductLink(l.href)) : [];
    const catalogs = shopping ? links.filter((l) => isCatalogLink(l.href)) : [];
    const pool = products.length > 0 ? products : catalogs.length > 0 ? catalogs : links;
    const nav = await d.click(pickLink(rng, pool), rng);
    if (!nav.ok) break;
    const landed = await d.currentUrl();
    if (BLOCK_PAGE.test(landed)) {
      rec.error ??= BLOCKED_BY_SITE;
      c.log.warn("blocked by the site", { site: v.site, url: landed });
      break;
    }
    rec.hops++;
    if (shopping) {
      if (isProductLink(landed)) rec.products++;
      else if (isCatalogLink(landed)) rec.catalogs++;
    }
    if (!rec.consent) rec.consent = await d.handleConsent();
    await dwellAndScroll(d, rng, Math.round(v.dwellMs * rng.float(0.4, 0.9)), c);
    if (rng.chance(0.3)) {
      await d.back();
      await c.sleep(pacedMs(rng, 1_200, 4_000), c.signal);
    }
  }
}

/** Search for the site, then click the organic result that points at it. Falls back to direct if the SERP doesn't offer one. */
async function viaSearch(v: PlannedVisit, d: Driver, rng: Rng, c: Ctx): Promise<boolean> {
  const url = `${c.searchEngine}${encodeURIComponent(v.searchQuery!)}`;
  const nav = await d.goto(url);
  if (!nav.ok) return false;
  await d.handleConsent();
  // read the results page like a person scanning for the right link
  await c.sleep(readPauseMs(rng), c.signal);
  for (const s of scrollFlick(rng)) await d.scroll(s);
  await c.sleep(readPauseMs(rng), c.signal);
  for (const s of scrollFlick(rng)) await d.scroll(s);
  const links = await d.collectLinks(80);
  const wantHost = hostOf(v.url);
  // exact host first (www.amazon.com), then anything on the same registrable domain
  const hits = links
    .filter((l) => registrableDomain(hostOf(l.href)) === v.site)
    .sort((a, b) => Number(hostOf(b.href) === wantHost) - Number(hostOf(a.href) === wantHost) || Number(b.href.startsWith(v.url)) - Number(a.href.startsWith(v.url)));
  if (hits.length === 0) return false;
  const res = await d.click(hits[0]!, rng);
  return res.ok && registrableDomain(hostOf(await d.currentUrl())) === v.site;
}

/** Spend `budgetMs` on the page as a reader would: wander, scroll in bursts, pause, repeat. */
async function dwellAndScroll(d: Driver, rng: Rng, budgetMs: number, c: Ctx): Promise<void> {
  const end = Date.now() + budgetMs;
  let virtual = 0; // for injected sleeps, track the budget ourselves
  // never overshoot the page's time budget by more than a little (matters at a slow pace)
  const cap = (ms: number) => Math.max(300, Math.min(ms, c.sleep === realSleep ? end - Date.now() + 1_500 : ms));

  // take in the page before touching the wheel
  await d.wander(rng);
  const settle = cap(settleMs(rng));
  await c.sleep(settle, c.signal);
  virtual += settle;

  while (virtual < budgetMs && Date.now() < end + 1 && !c.signal?.aborted) {
    // a small scroll, then STOP and read — not a long continuous glide
    for (const s of scrollFlick(rng)) {
      await d.scroll(s);
      virtual += s.steps * s.pauseMs;
    }
    const pause = cap(readPauseMs(rng));
    await c.sleep(pause, c.signal);
    virtual += pause;
    if (rng.chance(0.2)) await d.wander(rng);
    // occasionally just read for a while without scrolling, like real reading
    if (rng.chance(0.14) && (c.sleep !== realSleep || end - Date.now() > 6_000)) {
      const long = cap(longReadMs(rng));
      await c.sleep(long, c.signal);
      virtual += long;
    }
    if (c.sleep === realSleep && Date.now() >= end) break;
  }
}

function pickLink(rng: Rng, links: LinkCandidate[]): LinkCandidate {
  // prefer links with real words over "›" or "1"
  const good = links.filter((l) => /[a-z]{3,}/i.test(l.text));
  return rng.pick(good.length ? good : links);
}
