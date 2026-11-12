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
  /**
   * True when the claim could not be evaluated in this context (e.g. the
   * probe page is not a secure context in proxy mode, so userAgentData is
   * spec-absent). A skip is not a pass and not a fail — the claim must be
   * covered by another run. Skip, never fake.
   */
  skipped?: boolean;
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
  {
    id: "webrtc-no-host-candidates",
    title: "WebRTC SDP contains no host/srflx (local network) candidates",
    async check(page) {
      // Fury patch 0070 (WebRTC IP policy). Control measured on stock Chrome:
      // with no proxy policy, createOffer gathers typ host AND typ srflx
      // candidates from every local interface — that leak is exactly what the
      // patch kills. A proxied/patched engine yields relay-only or none.
      const v = (await page.evaluate(`(async () => {
        const pc = new RTCPeerConnection();
        try {
          pc.createDataChannel('q');
          await pc.setLocalDescription(await pc.createOffer());
          await new Promise(res => {
            if (pc.iceGatheringState === 'complete') return res();
            pc.addEventListener('icegatheringstatechange', () => {
              if (pc.iceGatheringState === 'complete') res();
            });
            setTimeout(res, 8000);
          });
          const m = pc.localDescription ? pc.localDescription.sdp.match(/typ \\w+/g) : null;
          return { types: m ? [...new Set(m)] : [] };
        } finally {
          try { pc.close(); } catch {}
        }
      })()`)) as { types: string[] };
      const bad = v.types.filter((t) => /host|srflx/.test(t));
      return result(
        "webrtc-no-host-candidates",
        bad.length === 0,
        bad.length ? `leaks: ${v.types.join(" ")}` : `clean (${v.types.join(" ") || "no candidates"})`,
      );
    },
  },
  {
    id: "audio-deterministic",
    title: "OfflineAudioContext readback is identical across two fresh contexts",
    async check(page) {
      // Fury patch 0040 (audio noise). Fury's noise is a pure function of the
      // per-profile seed, so two INDEPENDENT OfflineAudioContext runs on the
      // same page must produce byte-identical buffers. Stock Chrome (no noise)
      // is trivially deterministic too — this claim verifies determinism, not
      // noise-ness; noise calibration lives in the engine-side tests.
      const v = (await page.evaluate(`(async () => {
        const run = async () => {
          const ctx = new OfflineAudioContext(1, 4410, 44100);
          const osc = ctx.createOscillator();
          const comp = ctx.createDynamicsCompressor();
          osc.type = 'triangle'; osc.frequency.value = 1000;
          osc.connect(comp); comp.connect(ctx.destination);
          osc.start(0);
          const buf = await ctx.startRendering();
          const d = buf.getChannelData(0);
          let h = 0;
          for (let i = 0; i < d.length; i++) h = Math.imul(31, h) + (d[i] * 1e6 | 0) | 0;
          return h;
        };
        const a = await run();
        const b = await run();
        return { a, b, same: a === b };
      })()`)) as { a: number; b: number; same: boolean };
      return result(
        "audio-deterministic",
        v.same,
        v.same ? "two contexts identical" : `hashes ${v.a} vs ${v.b} differ`,
      );
    },
  },
  {
    id: "fonts-standard-families",
    title: "core web font families resolve (Arial/monospace/Times)",
    async check(page) {
      // Fury patches 0050/0051 (font metrics & family surface). A Windows
      // persona must at minimum resolve the standard families document.fonts
      // knows on real desktop Chrome — absence means the font table was
      // stripped past stock shape.
      const v = (await page.evaluate(`(() => {
        const probe = ['12px Arial', '16px monospace', '14px "Times New Roman"'];
        return probe.map(f => ({ f, ok: document.fonts.check(f) }));
      })()`)) as { f: string; ok: boolean }[];
      const missing = v.filter((x) => !x.ok).map((x) => x.f);
      return result(
        "fonts-standard-families",
        missing.length === 0,
        missing.length ? `unresolved: ${missing.join(", ")}` : "3/3 standard families resolve",
      );
    },
  },
  {
    id: "webgpu-present-or-null",
    title: "WebGPU API present and requestAdapter resolves (null OK without GPU)",
    async check(page) {
      // Fury patch 0032 (WebGPU surface). Stock Chrome on a GPU-less VM
      // resolves requestAdapter() to null — that is a PASS. A fail is a
      // missing navigator.gpu or a REJECTED adapter request (hook half-done).
      const v = (await page.evaluate(`(async () => {
        if (!('gpu' in navigator)) return { api: false, rejected: false, adapter: false };
        try {
          const a = await navigator.gpu.requestAdapter();
          return { api: true, rejected: false, adapter: a !== null };
        } catch {
          return { api: true, rejected: true, adapter: false };
        }
      })()`)) as { api: boolean; rejected: boolean; adapter: boolean };
      const ok = v.api && !v.rejected;
      return result(
        "webgpu-present-or-null",
        ok,
        !v.api ? "navigator.gpu missing" : v.rejected ? "requestAdapter rejected" : `adapter=${v.adapter ? "present" : "null (no GPU, OK)"}`,
      );
    },
  },
  {
    id: "battery-desktop-mains",
    title: "Battery API reports desktop-on-mains tuple (charging, level 1)",
    async check(page) {
      // Fury patch 0121 (battery spoof). The persona is a desktop on mains:
      // {charging: true, level: 1.0, dischargingTime: Infinity}. A laptop host
      // leaks its real battery (charging: false, level ~0.6) through an
      // unpatched engine. getBattery needs a secure context — if absent we
      // skip rather than fake.
      const v = (await page.evaluate(`(async () => {
        if (!('getBattery' in navigator)) return { api: null };
        const b = await navigator.getBattery();
        return { api: true, charging: b.charging, level: b.level, dt: b.dischargingTime };
      })()`)) as { api: boolean | null; charging?: boolean; level?: number; dt?: number };
      if (v.api === null) {
        return { id: "battery-desktop-mains", pass: false, skipped: true, detail: "getBattery unavailable (non-secure context)" };
      }
      const ok = v.charging === true && v.level === 1;
      return result(
        "battery-desktop-mains",
        ok,
        `charging=${v.charging} level=${v.level} dt=${String(v.dt)}`,
      );
    },
  },
  {
    id: "media-devices-sane",
    title: "enumerateDevices resolves with at least one audio output",
    async check(page) {
      // Fury patch 0060 (media device surface). Claim is coherence, not a
      // fabricated list: the API must resolve and report the sink the page
      // actually has. Stock Chrome always yields >= 1 audiooutput.
      const v = (await page.evaluate(`(async () => {
        const ds = await navigator.mediaDevices.enumerateDevices();
        return {
          kinds: ds.map(d => d.kind),
          out: ds.filter(d => d.kind === 'audiooutput').length,
        };
      })()`)) as { kinds: string[]; out: number };
      return result(
        "media-devices-sane",
        v.out >= 1,
        v.out >= 1 ? `${v.kinds.length} devices, ${v.out} audioout` : `no audiooutput (${v.kinds.join(",") || "empty"})`,
      );
    },
  },
  {
    id: "client-rects-deterministic",
    title: "getBoundingClientRect/getClientRects are stable across repeated reads",
    async check(page) {
      // Fury patch 0033 (rect noise). If a noise seed is applied per read
      // instead of per profile, two immediate reads of the same static box
      // disagree. Deterministic engine: identical every time.
      const v = (await page.evaluate(`(() => {
        const el = document.createElement('div');
        el.style.cssText = 'position:absolute;left:37.5px;top:11.25px;width:200.5px;height:80.75px;';
        document.body.appendChild(el);
        const r1 = JSON.stringify(el.getBoundingClientRect());
        const r2 = JSON.stringify(el.getBoundingClientRect());
        const c1 = JSON.stringify(el.getClientRects());
        const c2 = JSON.stringify(el.getClientRects());
        el.remove();
        return { rectSame: r1 === r2, clientSame: c1 === c2 };
      })()`)) as { rectSame: boolean; clientSame: boolean };
      const ok = v.rectSame && v.clientSame;
      return result(
        "client-rects-deterministic",
        ok,
        ok ? "rect+clientRects stable" : `rectSame=${v.rectSame} clientSame=${v.clientSame}`,
      );
    },
  },
  {
    id: "performance-memory-present",
    title: "performance.memory exposes a heap limit (Chrome-only surface)",
    async check(page) {
      // Fury patch 0120 (memory surface). performance.memory exists only in
      // Chromium; a fork that accidentally runs a non-Chrome-shaped page
      // (or strips the object) loses this API and stands out. jsHeapSizeLimit
      // is the most stable field across versions.
      const v = (await page.evaluate(`(() => {
        const m = performance.memory;
        return m ? { limit: m.jsHeapSizeLimit } : null;
      })()`)) as { limit: number } | null;
      return result(
        "performance-memory-present",
        v !== null && v.limit > 0,
        v === null ? "performance.memory missing" : `jsHeapSizeLimit=${v.limit}`,
      );
    },
  },
  {
    id: "speech-voices-sane",
    title: "speechSynthesis voices resolve, are non-empty, stable, well-formed",
    async check(page) {
      // Fury patches 0041/0042 (speech voice surface + Google network voices).
      // Persona-narrowed voice lists (e.g. a de-DE desktop exposing only German
      // local voices) belong to expectationClaims once the persona grows a
      // voices field; this claim covers the stock-shape invariants every real
      // desktop Chrome satisfies on Windows:
      //  - getVoices() may be [] on first call; real Chrome populates
      //    asynchronously via voiceschanged. Wait for it (3s cap).
      //  - a real desktop has >= 1 voice (Windows SAPI always provides some)
      //  - two reads after population are identical (no per-call noise)
      //  - each voice has a non-empty name and a BCP-47-shaped lang
      const v = (await page.evaluate(`(async () => {
        if (!('speechSynthesis' in window)) return { api: false, voices: null };
        const read = () => speechSynthesis.getVoices().map(x => ({
          name: x.name, lang: x.lang, local: x.localService,
        }));
        let voices = read();
        if (voices.length === 0) {
          voices = await new Promise(res => {
            const to = setTimeout(() => res(read()), 3000);
            speechSynthesis.onvoiceschanged = () => {
              const r = read();
              if (r.length > 0) { clearTimeout(to); res(r); }
            };
            speechSynthesis.getVoices();
          });
        }
        const again = read();
        const bad = voices.filter(x => !x.name || !/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(x.lang));
        return {
          api: true,
          count: voices.length,
          stable: JSON.stringify(voices) === JSON.stringify(again),
          malformed: bad.length,
        };
      })()`)) as {
        api: boolean;
        count?: number;
        stable?: boolean;
        malformed?: number;
      };
      if (!v.api) return result("speech-voices-sane", false, "speechSynthesis missing");
      const ok =
        (v.count ?? 0) >= 1 && v.stable === true && (v.malformed ?? 1) === 0;
      return result(
        "speech-voices-sane",
        ok,
        `voices=${v.count} stable=${v.stable} malformed=${v.malformed}`,
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
