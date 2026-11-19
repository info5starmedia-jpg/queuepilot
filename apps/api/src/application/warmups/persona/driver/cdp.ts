// @ts-nocheck -- vendored verbatim from the owner's mlx-warmup (C:/multilogin/mlxwarmup/mlx-warmup); it type-checks under that project's tsconfig. QueuePilot's stricter flags (exactOptionalPropertyTypes, no DOM lib) are not applied to it.
import { chromium, type Browser, type BrowserContext, type CDPSession, type Frame, type Page } from "playwright-core";
import { DriverError, errorMessage } from "../core/errors.js";
import type { Logger } from "../core/logger.js";
import type { Rng } from "../core/random.js";
import { sleep } from "../core/time.js";
import { canonicalLink, hostOf, isFollowable, registrableDomain, sameSite } from "../core/url.js";
import { CONSENT_CLICKABLES, CONSENT_FRAME_HINTS, CONSENT_SELECTORS, CONSENT_TEXT } from "./consent.js";
import type { Driver, LinkCandidate, NavResult, ScrollSpec, StorageSnapshot } from "./Driver.js";
import { clickPoint, hesitationMs, mousePath } from "./humanize.js";

export interface CdpDriverOptions {
  /** e.g. http://127.0.0.1:54321 — what the launcher returned. */
  browserUrl: string;
  logger: Logger;
  connectTimeoutMs?: number;
  navTimeoutMs?: number;
  /**
   * Proxy login for the profile. Anti-detect browsers answer proxy auth for human
   * browsing, but CDP-driven navigation gets its own 407 challenge — without this,
   * every page load fails with ERR_INVALID_AUTH_CREDENTIALS.
   */
  proxyAuth?: { username: string; password: string };
}

/**
 * Drives a Multilogin Mimic profile over CDP with Playwright.
 *
 * Two rules that decide whether warmup works at all:
 *  1. Use `browser.contexts()[0]` — the profile's real context. `newContext()` over CDP
 *     is incognito-style and its cookies never reach the profile on disk.
 *  2. Never close the browser from here. `dispose()` only detaches; the target stops
 *     the profile through the launcher so Multilogin flushes and syncs profile state.
 */
export class CdpDriver implements Driver {
  readonly kind = "browser" as const;
  private browser!: Browser;
  private context!: BrowserContext;
  private page!: Page;
  private readonly navTimeout: number;
  private mouse = { x: 400, y: 300 };

  private constructor(private readonly o: CdpDriverOptions) {
    this.navTimeout = o.navTimeoutMs ?? 45_000;
  }

  static async connect(o: CdpDriverOptions): Promise<CdpDriver> {
    const d = new CdpDriver(o);
    d.browser = await chromium.connectOverCDP(o.browserUrl, { timeout: o.connectTimeoutMs ?? 30_000 });
    const contexts = d.browser.contexts();
    const ctx = contexts[0];
    if (!ctx) throw new DriverError("connected over CDP but the browser exposed no default context");
    d.context = ctx;
    d.page = ctx.pages()[0] ?? (await ctx.newPage());
    // Close any tab that pops open during the session so focus stays on our page.
    ctx.on("page", (p) => {
      if (p !== d.page) p.close().catch(() => {});
    });
    d.page.setDefaultTimeout(d.navTimeout);
    if (o.proxyAuth?.username) await d.installProxyAuth(o.proxyAuth);
    return d;
  }

  /**
   * Answer the proxy's 407 auth challenge for every page. Enables the CDP Fetch domain
   * with auth handling: each request is waved through, and auth challenges are answered
   * with the profile's proxy credentials.
   */
  private async installProxyAuth(auth: { username: string; password: string }): Promise<void> {
    const setup = async (page: Page): Promise<void> => {
      try {
        const cdp: CDPSession = await this.context.newCDPSession(page);
        await cdp.send("Fetch.enable", { handleAuthRequests: true, patterns: [{ urlPattern: "*" }] });
        cdp.on("Fetch.authRequired", (e: { requestId: string }) => {
          void cdp
            .send("Fetch.continueWithAuth", {
              requestId: e.requestId,
              authChallengeResponse: { response: "ProvideCredentials", username: auth.username, password: auth.password },
            })
            .catch(() => {});
        });
        cdp.on("Fetch.requestPaused", (e: { requestId: string }) => {
          void cdp.send("Fetch.continueRequest", { requestId: e.requestId }).catch(() => {});
        });
      } catch (err) {
        this.o.logger.warn("could not install proxy auth handler", { error: errorMessage(err) });
      }
    };
    await setup(this.page);
    this.context.on("page", (p) => void setup(p).catch(() => {}));
    this.o.logger.debug("proxy auth handler installed");
  }

  async goto(url: string, o: { referer?: string; timeoutMs?: number } = {}, attempt = 0): Promise<NavResult> {
    try {
      const resp = await this.page.goto(url, {
        referer: o.referer,
        waitUntil: "domcontentloaded",
        timeout: o.timeoutMs ?? this.navTimeout,
      });
      await this.page.waitForLoadState("load", { timeout: 15_000 }).catch(() => {});
      return { url: this.page.url(), title: await this.safeTitle(), ok: resp?.ok() ?? true, status: resp?.status() };
    } catch (e) {
      const msg = errorMessage(e);
      // Something else (a click's navigation, an error page committing) clobbered ours. Let the
      // frame settle and try once more rather than reporting a phantom failure.
      if (attempt === 0 && /interrupted by another navigation|frame was detached|Navigation failed because page was closed/i.test(msg)) {
        this.o.logger.debug("goto: interrupted — settling and retrying once", { url });
        await this.page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => {});
        await sleep(1_000);
        return this.goto(url, o, 1);
      }
      // Give a failed navigation's error page time to commit so the NEXT goto doesn't collide with it.
      await this.page.waitForLoadState("domcontentloaded", { timeout: 3_000 }).catch(() => {});
      this.o.logger.debug("goto failed", { url, error: msg.split("\n")[0] });
      return { url, title: "", ok: false, error: msg };
    }
  }

  async currentUrl(): Promise<string> {
    return this.page.url();
  }

  async scroll(spec: ScrollSpec): Promise<void> {
    const per = spec.distance / Math.max(1, spec.steps);
    const sign = spec.direction === "down" ? 1 : -1;
    for (let i = 0; i < spec.steps; i++) {
      // one gentle wheel notch, with a little natural variation — no big amplified jumps
      const jitter = 0.85 + Math.random() * 0.3;
      await this.page.mouse.wheel(0, Math.round(sign * per * jitter)).catch(() => {});
      await sleep(Math.max(200, spec.pauseMs + Math.round((Math.random() * 2 - 1) * 90)));
    }
  }

  async collectLinks(max = 60): Promise<LinkCandidate[]> {
    const current = this.page.url();
    let raw: Array<{ href: string; attr: string; text: string }> = [];
    try {
      raw = await this.page.evaluate((limit: number) => {
        const out: Array<{ href: string; attr: string; text: string }> = [];
        const seen = new Set<string>();
        const vh = window.innerHeight;
        for (const a of Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"))) {
          const href = a.href;
          if (!href || seen.has(href)) continue;
          const r = a.getBoundingClientRect();
          if (r.width < 8 || r.height < 8) continue;
          if (r.bottom < -vh * 2 || r.top > vh * 4) continue; // roughly near the viewport
          const text = (a.innerText || a.getAttribute("aria-label") || a.title || "").trim().slice(0, 80);
          if (!text) continue;
          seen.add(href);
          out.push({ href, attr: a.getAttribute("href") ?? href, text });
          if (out.length >= limit) break;
        }
        return out;
      }, max * 3);
    } catch {
      return [];
    }
    const out: LinkCandidate[] = [];
    // One tile is often linked several times over with different tracking suffixes. Keyed on
    // the raw href those look like different destinations, which fills the budget with
    // duplicates and makes the picker favour whichever item has the most variants.
    const seen = new Set<string>([canonicalLink(current)]);
    for (const l of raw) {
      if (!isFollowable(l.href)) continue;
      if (hostOf(l.href) === hostOf(current) && new URL(l.href).pathname === new URL(current).pathname) continue;
      const key = canonicalLink(l.href);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ href: l.href, attr: l.attr, text: l.text, internal: sameSite(l.href, current) });
      if (out.length >= max) break;
    }
    return out;
  }

  async click(link: LinkCandidate, rng: Rng): Promise<NavResult> {
    const from = this.page.url();
    try {
      const loc = this.page.locator(`a[href="${cssEscape(link.attr ?? link.href)}"]`).first();
      const box = await loc.boundingBox({ timeout: 3_000 }).catch(() => null);
      if (!box) {
        // Rendered off-screen or obscured: take the link with the referer a click would have had.
        this.o.logger.debug("click: not locatable → goto", { href: link.href });
        return this.goto(link.href, { referer: from });
      }
      await loc.scrollIntoViewIfNeeded({ timeout: 3_000 }).catch(() => {});
      const box2 = (await loc.boundingBox({ timeout: 2_000 }).catch(() => null)) ?? box;
      const target = clickPoint(rng, box2);
      for (const p of mousePath(rng, this.mouse, target, rng.int(8, 16))) {
        await this.page.mouse.move(p.x, p.y);
        await sleep(rng.int(8, 25));
      }
      this.mouse = target;
      await sleep(hesitationMs(rng));

      const popup = this.page.waitForEvent("popup", { timeout: 2_500 }).catch(() => null);
      await this.page.mouse.click(target.x, target.y);
      const p = await popup;
      if (p) {
        // target=_blank: close the new tab and take the link in our tab with a real referer instead.
        this.o.logger.debug("click: popup → goto in main tab", { href: link.href });
        await p.close().catch(() => {});
        return this.goto(link.href, { referer: from });
      }
      // Give the click's navigation time to commit before deciding it did nothing — calling goto()
      // while a click navigation is still in flight aborts it and surfaces as chrome-error://.
      const changed = await this.page
        .waitForURL((u) => u.toString() !== from, { timeout: 10_000, waitUntil: "commit" })
        .then(() => true)
        .catch(() => false);
      if (!changed) {
        this.o.logger.debug("click: url unchanged → goto", { href: link.href });
        return this.goto(link.href, { referer: from });
      }
      await this.page.waitForLoadState("domcontentloaded", { timeout: this.navTimeout }).catch(() => {});
      await this.page.waitForLoadState("load", { timeout: 15_000 }).catch(() => {});
      return { url: this.page.url(), title: await this.safeTitle(), ok: true };
    } catch (e) {
      this.o.logger.debug("click: threw", { href: link.href, error: errorMessage(e) });
      return { url: link.href, title: "", ok: false, error: errorMessage(e) };
    }
  }

  async back(): Promise<void> {
    await this.page.goBack({ waitUntil: "domcontentloaded", timeout: this.navTimeout }).catch(() => {});
  }

  async handleConsent(): Promise<boolean> {
    const frames: Array<Page | Frame> = [this.page, ...this.page.frames().filter((f) => CONSENT_FRAME_HINTS.test(f.url()) || CONSENT_FRAME_HINTS.test(f.name()))];
    for (const scope of frames) {
      // 1) known CMPs by id/class — precise
      for (const sel of CONSENT_SELECTORS) {
        if (await this.tryClick(scope.locator(sel).first(), sel)) return true;
      }
      // 2) anything clickable whose whole text is an accept phrase — anchored, so "Cookie settings" never matches
      if (await this.tryClick(scope.locator(CONSENT_CLICKABLES).filter({ hasText: CONSENT_TEXT }).first(), "text-match")) return true;
    }
    return false;
  }

  private async tryClick(loc: import("playwright-core").Locator, label: string): Promise<boolean> {
    try {
      if ((await loc.count()) === 0) return false;
      if (!(await loc.isVisible({ timeout: 300 }).catch(() => false))) return false;
      await sleep(400 + Math.random() * 600);
      await loc.click({ timeout: 3_000 });
      this.o.logger.debug("consent accepted", { via: label, url: this.page.url() });
      await sleep(600);
      return true;
    } catch {
      return false;
    }
  }

  async wander(rng: Rng): Promise<void> {
    const vp = this.page.viewportSize() ?? { width: 1280, height: 800 };
    const moves = rng.int(2, 5);
    for (let i = 0; i < moves; i++) {
      const to = { x: rng.int(60, vp.width - 60), y: rng.int(80, vp.height - 60) };
      for (const p of mousePath(rng, this.mouse, to, rng.int(6, 12))) {
        await this.page.mouse.move(p.x, p.y).catch(() => {});
        await sleep(rng.int(10, 30));
      }
      this.mouse = to;
      await sleep(rng.int(150, 500));
    }
  }

  async snapshotStorage(): Promise<StorageSnapshot> {
    const cookies = await this.context.cookies().catch(() => []);
    const domains = new Set<string>();
    for (const c of cookies) domains.add(registrableDomain(c.domain));
    let localStorageKeys = 0;
    let historyDepth = 0;
    try {
      const r = await this.page.evaluate(() => ({ ls: window.localStorage.length, h: window.history.length }));
      localStorageKeys = r.ls;
      historyDepth = r.h;
    } catch {
      /* about:blank or cross-origin restrictions */
    }
    return {
      cookies: cookies.map((c) => ({ name: c.name, domain: c.domain, expires: c.expires })),
      domains: [...domains].sort(),
      localStorageKeys,
      historyDepth,
      takenAt: Date.now(),
    };
  }

  /**
   * Flush-then-detach. Chromium writes cookies/localStorage on timers and at clean exit, so we
   * park on about:blank for a moment before letting go. The browser keeps running until the
   * target stops it through the launcher.
   */
  async dispose(): Promise<void> {
    try {
      await this.page.goto("about:blank", { timeout: 10_000 }).catch(() => {});
      await sleep(3_000);
    } finally {
      await this.browser.close().catch(() => {});
    }
  }

  private async safeTitle(): Promise<string> {
    return this.page.title().catch(() => "");
  }
}

function cssEscape(s: string): string {
  return s.replace(/["\\]/g, "\\$&");
}
