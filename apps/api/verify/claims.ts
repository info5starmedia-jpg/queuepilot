import type { PageProbe } from "../src/application/runtime/cdp/cdp-page.js";

/**
 * Detection claim suite — our own implementation of Fury's claim-based
 * verification methodology (their verify scripts are AGPL; the METHODOLOGY is
 * documented in their README and is what we adopt):
 *
 *  - State claims, not steps. "position is the configured one" can fail
 *    informatively; "call getCurrentPosition" cannot.
 *  - One line per claim, exit non-zero if any claim is false.
 *  - Run against the real engine launched the way the product launches it.
 *
 * A claim returns pass/fail + a one-line detail. Claims never throw for an
 * ordinary failure — a thrown probe error means the harness broke, which the
 * runner reports separately (PROBE-ERROR is a failure too, but a different
 * kind).
 */
export interface ClaimResult {
  id: string;
  pass: boolean;
  detail: string;
}

export interface Claim {
  id: string;
  title: string;
  check(page: PageProbe): Promise<ClaimResult>;
}

/** What the launch asked the engine to materialize; claims compare to this. */
export interface PersonaExpectation {
  userAgentContainsChrome?: boolean;
  platform?: string;
  hardwareConcurrency?: number;
  deviceMemory?: number;
  screenWidth?: number;
  screenHeight?: number;
  timezone?: string;
  locale?: string;
}

function result(id: string, pass: boolean, detail: string): ClaimResult {
  return { id, pass, detail };
}

export const CLAIMS: Claim[] = [
  {
    id: "webdriver-hidden",
    title: "navigator.webdriver is not true",
    async check(page) {
      const v = await page.evaluate("navigator.webdriver");
      return result(
        "webdriver-hidden",
        v === false || v === undefined,
        `webdriver=${String(v)}`,
      );
    },
  },
  {
    id: "ua-stock-shaped",
    title: "userAgent is stock-Chrome-shaped (no HeadlessChrome, no brand leak)",
    async check(page) {
      const ua = String(await page.evaluate("navigator.userAgent"));
      const ok =
        /Chrome\/\d+\.\d+\.\d+\.\d+/.test(ua) &&
        !/HeadlessChrome/i.test(ua) &&
        !/fury|camoufox|queuepilot/i.test(ua);
      return result("ua-stock-shaped", ok, ua);
    },
  },
  {
    id: "uach-consistent",
    title: "UA client hints agree with the userAgent",
    async check(page) {
      const v = (await page.evaluate(`(() => {
        const d = navigator.userAgentData;
        if (!d) return null;
        return { brands: d.brands.map(b => b.brand), mobile: d.mobile, platform: d.platform };
      })()`)) as { brands: string[]; platform: string } | null;
      if (!v) return result("uach-consistent", false, "userAgentData missing");
      const hasChromium = v.brands.some((b) => /chrom/i.test(b));
      return result(
        "uach-consistent",
        hasChromium && v.brands.length >= 2,
        `brands=${v.brands.join(",")} platform=${v.platform}`,
      );
    },
  },
  {
    id: "chrome-object",
    title: "window.chrome stock surface (loadTimes/csi)",
    async check(page) {
      // Ground truth measured against stock Chrome 156/157 on a plain HTTP
      // page: window.chrome = { loadTimes, csi } headful, plus `app` in
      // headless=new. chrome.runtime is NOT exposed to web pages in either
      // mode — requiring it would fail stock Chrome itself. Assert the
      // universal core only; extra keys are tolerated (version-dependent).
      const v = await page.evaluate(
        "typeof window.chrome === 'object' && window.chrome !== null" +
          " && typeof window.chrome.loadTimes === 'function'" +
          " && typeof window.chrome.csi === 'function'",
      );
      return result("chrome-object", v === true, `window.chrome stock surface=${String(v)}`);
    },
  },
  {
    id: "no-automation-traces",
    title: "no cdc_/driver DOM traces",
    async check(page) {
      const v = await page.evaluate(`(() => {
        const keys = Object.getOwnPropertyNames(document).filter(k => /cdc_|\\$cdc/.test(k));
        const win = Object.getOwnPropertyNames(window).filter(k => /cdc_|selenium|webdriver|driver/i.test(k) && k !== 'webdriver');
        return { doc: keys, win };
      })()`) as { doc: string[]; win: string[] };
      const leaks = [...v.doc, ...v.win];
      return result(
        "no-automation-traces",
        leaks.length === 0,
        leaks.length ? `leaks: ${leaks.join(",")}` : "clean",
      );
    },
  },
  {
    id: "plugins-present",
    title: "navigator.plugins is non-empty (PDF viewer surface)",
    async check(page) {
      const n = Number(await page.evaluate("navigator.plugins.length"));
      return result("plugins-present", n > 0, `plugins=${n}`);
    },
  },
  {
    id: "permissions-consistent",
    title: "Notification.permission matches permissions.query",
    async check(page) {
      const v = (await page.evaluate(`(async () => {
        if (typeof Notification === 'undefined') return { api: null, query: null };
        const q = await navigator.permissions.query({ name: 'notifications' });
        return { api: Notification.permission, query: q.state };
      })()`)) as { api: string | null; query: string | null };
      // Stock Chrome's own vocabulary: "default" and "prompt" are the SAME
      // state in the two APIs. The mismatch signal is anything else.
      const norm = (s: string | null) => (s === "default" ? "prompt" : s);
      const ok = v.api !== null && norm(v.api) === norm(v.query);
      return result(
        "permissions-consistent",
        ok,
        `Notification=${v.api} query=${v.query}`,
      );
    },
  },
  {
    id: "worker-consistency",
    title: "a Worker sees the same UA/platform/hardware as the main thread",
    async check(page) {
      const v = (await page.evaluate(`(async () => {
        const main = {
          ua: navigator.userAgent,
          platform: navigator.platform,
          hc: navigator.hardwareConcurrency,
          lang: navigator.language,
        };
        const blob = new Blob(['onmessage = e => { const n = navigator; postMessage({ ua: n.userAgent, platform: n.platform, hc: n.hardwareConcurrency, lang: n.language }); }'], { type: 'text/javascript' });
        const w = new Worker(URL.createObjectURL(blob));
        const worker = await new Promise((res, rej) => {
          w.onmessage = e => res(e.data);
          w.onerror = e => rej(new Error('worker failed'));
          w.postMessage('go');
        });
        w.terminate();
        const diff = Object.keys(main).filter(k => main[k] !== worker[k]);
        return { diff };
      })()`)) as { diff: string[] };
      return result(
        "worker-consistency",
        v.diff.length === 0,
        v.diff.length ? `worker disagrees on: ${v.diff.join(",")}` : "identical in worker",
      );
    },
  },
  {
    id: "canvas-deterministic",
    title: "canvas readback is deterministic within a session",
    async check(page) {
      const v = await page.evaluate(`(() => {
        const draw = () => {
          const c = document.createElement('canvas');
          c.width = 220; c.height = 60;
          const g = c.getContext('2d');
          g.textBaseline = 'top'; g.font = '16px Arial';
          g.fillStyle = '#069'; g.fillRect(2, 2, 100, 30);
          g.fillStyle = '#f60'; g.fillText('QueuePilot probe \u{1F980}', 4, 16);
          return c.toDataURL();
        };
        return draw() === draw();
      })()`);
      return result(
        "canvas-deterministic",
        v === true,
        v === true ? "two draws identical" : "two draws differ (noise unstable)",
      );
    },
  },
  {
    id: "webgl-coherent",
    title: "WebGL vendor/renderer present and identical across contexts",
    async check(page) {
      const v = (await page.evaluate(`(() => {
        const read = () => {
          const c = document.createElement('canvas');
          const gl = c.getContext('webgl');
          if (!gl) return null;
          const d = gl.getExtension('WEBGL_debug_renderer_info');
          return d ? gl.getParameter(d.UNMASKED_VENDOR_WEBGL) + ' | ' + gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'no-debug-info';
        };
        const a = read(), b = read();
        return { a, b, same: a === b };
      })()`)) as { a: string | null; b: string | null; same: boolean };
      const ok = v.a !== null && v.same;
      return result(
        "webgl-coherent",
        ok,
        v.a === null ? "no webgl context" : v.same ? v.a : `contexts disagree: ${v.a} vs ${v.b}`,
      );
    },
  },
];

/**
 * Persona-bound claims: only meaningful when we know what the launch asked
 * for. Each is skipped (not failed) when the expectation is absent — the same
 * rule as attestation: absence of evidence is not evidence of mismatch.
 */
export function expectationClaims(expect: PersonaExpectation): Claim[] {
  const claims: Claim[] = [];
  const add = (
    id: string,
    title: string,
    expected: unknown,
    expression: string,
  ) => {
    if (expected === undefined || expected === null) return;
    claims.push({
      id,
      title,
      async check(page) {
        const actual = await page.evaluate(expression);
        const pass =
          typeof expected === "number"
            ? Number(actual) === expected
            : String(actual) === String(expected);
        return result(id, pass, `expected=${String(expected)} actual=${String(actual)}`);
      },
    });
  };
  add("persona-platform", "platform matches persona", expect.platform, "navigator.platform");
  add("persona-cores", "hardwareConcurrency matches persona", expect.hardwareConcurrency, "navigator.hardwareConcurrency");
  add("persona-memory", "deviceMemory matches persona", expect.deviceMemory, "navigator.deviceMemory ?? null");
  add("persona-screen", "screen matches persona", expect.screenWidth, "screen.width");
  add("persona-screen-h", "screen height matches persona", expect.screenHeight, "screen.height");
  add("persona-timezone", "timezone matches persona", expect.timezone, "Intl.DateTimeFormat().resolvedOptions().timeZone");
  add("persona-locale", "primary language matches persona", expect.locale, "navigator.languages[0] ?? navigator.language");
  return claims;
}
