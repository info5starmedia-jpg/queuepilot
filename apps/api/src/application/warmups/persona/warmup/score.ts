import type { StorageSnapshot } from "../driver/Driver.js";

export interface TrustScore {
  /** 0–100. */
  score: number;
  domainsBefore: number;
  domainsAfter: number;
  domainsGained: number;
  cookiesBefore: number;
  cookiesAfter: number;
  /** Share of cookies that outlive the session — persistent cookies are what make a profile look aged. */
  persistentRatio: number;
  historyDepth: number;
  localStorageKeys: number;
}

/**
 * A single number for "did this session build a trail?" Breadth of domains matters most,
 * then persistence, then depth. Deliberately simple and explained, so it can be argued with.
 */
export function trustScore(before: StorageSnapshot, after: StorageSnapshot): TrustScore {
  const now = Math.floor(Date.now() / 1000);
  const persistent = after.cookies.filter((c) => c.expires > now + 3600).length;
  const persistentRatio = after.cookies.length ? persistent / after.cookies.length : 0;
  const gained = Math.max(0, after.domains.length - before.domains.length);
  const score = Math.min(
    100,
    Math.round(
      Math.min(60, after.domains.length * 3) + // breadth (20 domains = 60)
        persistentRatio * 20 + // persistence
        Math.min(10, after.historyDepth) + // depth
        Math.min(10, gained * 2), // this session's contribution
    ),
  );
  return {
    score,
    domainsBefore: before.domains.length,
    domainsAfter: after.domains.length,
    domainsGained: gained,
    cookiesBefore: before.cookies.length,
    cookiesAfter: after.cookies.length,
    persistentRatio: Math.round(persistentRatio * 100) / 100,
    historyDepth: after.historyDepth,
    localStorageKeys: after.localStorageKeys,
  };
}
