import { getConfig } from "../core/config.js";
import type { Rng } from "../core/random.js";
import type { ScrollSpec } from "./Driver.js";

/**
 * Timing and motion shapes. Everything here is a distribution sampled from a seeded
 * Rng so a plan replays identically. Nothing here talks to a browser.
 */

/**
 * Global pace multiplier from WARMUP_PACE (0.5–4, default 1). Higher = slower and more
 * human. It scales the *pauses* (reading, scroll gaps, hesitation) — never the dwell
 * budget, so the plan/campaign length is unchanged; a slower pace just means calmer,
 * less frequent motion inside the same time on a page.
 */
export function pace(): number {
  try {
    return getConfig().WARMUP_PACE;
  } catch {
    return 1;
  }
}

export interface DwellParams {
  /** Median seconds on a page. */
  medianSec: number;
  /** Log-normal shape. 0.8 gives a realistic long tail. */
  sigma: number;
  minSec: number;
  maxSec: number;
  /** Fraction of visits that are quick bounces (< 10s). */
  bounceRate: number;
}

export const DEFAULT_DWELL: DwellParams = { medianSec: 45, sigma: 0.8, minSec: 4, maxSec: 600, bounceRate: 0.1 };

/** How long to stay on a page, in ms. Heavy-tailed, with occasional bounces. */
export function dwellMs(rng: Rng, p: DwellParams = DEFAULT_DWELL, multiplier = 1): number {
  if (rng.chance(p.bounceRate)) return rng.float(2_000, 9_000);
  const sec = rng.lognormal(p.medianSec * multiplier, p.sigma, p.minSec, p.maxSec);
  return Math.round(sec * 1000);
}

/**
 * ONE gentle scroll "flick": 1–3 real mouse-wheel notches (~90–150px each) with a small,
 * pace-scaled gap between them — like nudging the wheel, never holding it down. Sometimes a
 * tiny nudge back up, as if re-reading a line. The caller pauses to "read" between flicks
 * (see readPauseMs), so the page drifts down in small steps instead of gliding for seconds.
 */
export function scrollFlick(rng: Rng): ScrollSpec[] {
  const p = pace();
  const ticks = rng.int(1, 2); // just a nudge or two, never a long glide
  const perTick = rng.int(80, 140); // one notch ≈ 80–140px
  const specs: ScrollSpec[] = [
    { direction: "down", distance: ticks * perTick, steps: ticks, pauseMs: Math.round(rng.int(450, 1_000) * p) },
  ];
  if (rng.chance(0.12)) {
    specs.push({ direction: "up", distance: rng.int(70, 140), steps: 1, pauseMs: Math.round(rng.int(340, 680) * p) });
  }
  return specs;
}

/** Pause between scroll flicks — reading time. Heavy-tailed: most a few seconds, some long. */
export function readPauseMs(rng: Rng): number {
  return Math.round(rng.lognormal(4_000, 0.7, 1_100, 30_000) * pace());
}

/** Now and then the person just reads/watches for a while without touching the wheel. */
export function longReadMs(rng: Rng): number {
  return Math.round(rng.int(8_000, 24_000) * pace());
}

/** A short settle after a page loads, before touching anything. */
export function settleMs(rng: Rng): number {
  return Math.round(rng.int(900, 2_600) * pace());
}

/** A breath between two sites. */
export function betweenSitesMs(rng: Rng): number {
  return Math.round(rng.int(2_500, 9_000) * pace());
}

/** A generic pace-scaled pause in a [min, max] band, for one-off waits. */
export function pacedMs(rng: Rng, min: number, max: number): number {
  return Math.round(rng.int(min, max) * pace());
}

/** Short hesitation before acting on something (hover → click). */
export function hesitationMs(rng: Rng): number {
  return Math.round(rng.int(400, 1_400) * pace());
}

/** Click offset inside an element's box — never dead centre. */
export function clickPoint(rng: Rng, box: { x: number; y: number; width: number; height: number }): { x: number; y: number } {
  return {
    x: box.x + box.width * rng.float(0.2, 0.8),
    y: box.y + box.height * rng.float(0.25, 0.75),
  };
}

/** Number of internal pages to visit after landing on a site. */
export function internalHops(rng: Rng, max = 3): number {
  // weighted toward browsing a few pages, but capped by the site's max
  const r = rng.next();
  if (r < 0.2) return 0;
  if (r < 0.55) return Math.min(1, max);
  if (r < 0.85) return Math.min(2, max);
  return Math.min(max, rng.int(3, 4));
}

/** Bezier-ish path from a to b in `steps` points, with a little wobble. */
export function mousePath(rng: Rng, a: { x: number; y: number }, b: { x: number; y: number }, steps = 12): Array<{ x: number; y: number }> {
  const c1 = { x: a.x + (b.x - a.x) * rng.float(0.2, 0.5) + rng.float(-60, 60), y: a.y + (b.y - a.y) * rng.float(0, 0.4) + rng.float(-60, 60) };
  const c2 = { x: a.x + (b.x - a.x) * rng.float(0.5, 0.8) + rng.float(-60, 60), y: a.y + (b.y - a.y) * rng.float(0.6, 1) + rng.float(-60, 60) };
  const pts: Array<{ x: number; y: number }> = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const mt = 1 - t;
    pts.push({
      x: mt ** 3 * a.x + 3 * mt ** 2 * t * c1.x + 3 * mt * t ** 2 * c2.x + t ** 3 * b.x,
      y: mt ** 3 * a.y + 3 * mt ** 2 * t * c1.y + 3 * mt * t ** 2 * c2.y + t ** 3 * b.y,
    });
  }
  return pts;
}
