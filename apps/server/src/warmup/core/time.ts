import type { Rng } from "./random.js";

export const nowMs = (): number => Date.now();

/** Abortable sleep. Resolves early (without throwing) if the signal fires. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener("abort", done);
      clearTimeout(t);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

export function jitteredSleep(rng: Rng, baseMs: number, pct = 0.3, signal?: AbortSignal): Promise<void> {
  return sleep(Math.max(0, rng.jitter(baseMs, pct)), signal);
}

/** Hour of day (0–23) for `date` in an IANA timezone. */
export function hourIn(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hour12: false }).formatToParts(date);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  return h === 24 ? 0 : h;
}

/** Day of week (0=Sun) for `date` in a timezone. */
export function weekdayIn(date: Date, timeZone: string): number {
  const wd = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(date);
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(wd);
}

/** True if `date` falls inside [startHour, endHour) local to the timezone. Handles overnight windows. */
export function inActiveWindow(date: Date, timeZone: string, startHour: number, endHour: number): boolean {
  const h = hourIn(date, timeZone);
  if (startHour === endHour) return true;
  return startHour < endHour ? h >= startHour && h < endHour : h >= startHour || h < endHour;
}

/**
 * Exponential backoff with full jitter. attempt is 0-based.
 * 0→~0.5s, 1→~1s, 2→~2s … capped at maxMs.
 */
export function backoffMs(attempt: number, rng: Rng, baseMs = 500, maxMs = 60_000): number {
  const cap = Math.min(maxMs, baseMs * 2 ** attempt);
  return rng.float(0, cap);
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
