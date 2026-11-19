import type { Rng } from "../core/random.js";

export interface NavResult {
  url: string;
  title: string;
  ok: boolean;
  status?: number;
  error?: string;
}

export interface LinkCandidate {
  /** Absolute URL. */
  href: string;
  /** The raw href attribute as written in the DOM (may be relative) — used to locate the element. */
  attr?: string;
  text: string;
  /** Same registrable domain as the page it was found on. */
  internal: boolean;
}

export interface ScrollSpec {
  direction: "down" | "up";
  /** Total pixels (browser) or fraction of screen height (phone). */
  distance: number;
  steps: number;
  /** Pause between steps, ms. */
  pauseMs: number;
}

export interface CookieInfo {
  name: string;
  domain: string;
  /** Epoch seconds, or -1 for session cookies. */
  expires: number;
}

export interface StorageSnapshot {
  cookies: CookieInfo[];
  /** Distinct registrable domains holding at least one cookie. */
  domains: string[];
  /** localStorage keys on the current origin (browsers only). */
  localStorageKeys: number;
  /** window.history.length on the current page (browsers only). */
  historyDepth: number;
  takenAt: number;
}

/**
 * Everything the warmup engine needs from a browser or a phone. The engine never
 * touches Playwright or ADB directly — it drives this, so it can be tested against
 * `FakeDriver` with no network at all.
 */
export interface Driver {
  readonly kind: "browser" | "phone";
  goto(url: string, o?: { referer?: string; timeoutMs?: number }): Promise<NavResult>;
  currentUrl(): Promise<string>;
  scroll(spec: ScrollSpec): Promise<void>;
  /** Visible, followable links on the current page; `max` caps the scan. */
  collectLinks(max?: number): Promise<LinkCandidate[]>;
  click(link: LinkCandidate, rng: Rng): Promise<NavResult>;
  back(): Promise<void>;
  /** Try to accept a cookie/consent banner. True if one was dismissed. */
  handleConsent(): Promise<boolean>;
  /** Idle mouse/finger movement between actions. */
  wander(rng: Rng): Promise<void>;
  snapshotStorage(): Promise<StorageSnapshot>;
  /** Detach from the browser/phone. Does NOT stop it — the target owns the lifecycle. */
  dispose(): Promise<void>;
}
