/**
 * J6 — site readers (Jancy's Queue-it / Ticketmaster / AXS / Etix plug-ins).
 *
 * Split in two so the parsing is testable without a browser:
 * - PAGE_PROBE: one small read-only expression evaluated in an ISOLATED world
 *   of the tab (the page's own scripts can't see it). It only collects text
 *   and JSON-LD; it never clicks or changes anything.
 * - interpretProbe(): pure Node parsing of what the probe returned.
 *
 * Status: built from the Jancy wiki + public page structure; NOT yet checked
 * against a live queue (no live queue available on 2026-11-19).
 */

/** Queue domains (Jancy's list): Ticketmaster's 11+ TLDs, Live Nation, Queue-it, AXS, ATG, PAC. */
const QUEUE_HOST =
  /^(queue\.ticketmaster\.(com|ca|co\.uk|ie|com\.mx|com\.au|co\.nz|de|nl|be|se|dk|no|fi|es|fr|at|ch|pl|cz)|queue\.livenation\.com|[a-z0-9-]+\.queue-it\.net|queue\.atgtickets\.com|queue\.paclive\.com)$/i;
const TM_HOST = /(^|\.)(ticketmaster|livenation)\.[a-z.]+$/i;
const AXS_HOST = /(^|\.)axs\.com$/i;
const ETIX_HOST = /(^|\.)etix\.com$/i;
const SEATGEEK_HOST = /(^|\.)seatgeek\.com$/i;

export type SiteKind = "queue" | "ticketmaster" | "axs" | "etix" | "seatgeek";

/** Which reader applies to a URL (null = none; the tab is never touched). */
export function siteKindOf(url: string): SiteKind | null {
  let host: string;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    host = u.hostname;
  } catch {
    return null;
  }
  if (QUEUE_HOST.test(host)) return "queue";
  if (AXS_HOST.test(host) && /waiting|queue/i.test(url)) return "queue";
  if (TM_HOST.test(host)) return "ticketmaster";
  if (AXS_HOST.test(host)) return "axs";
  if (ETIX_HOST.test(host)) return "etix";
  if (SEATGEEK_HOST.test(host)) return "seatgeek";
  return null;
}

/**
 * Read-only probe. Returns visible text (capped), the Queue-it widgets' text
 * by their well-known ids, short "mm:ss" timer candidates with their nearby
 * label, and JSON-LD blocks (event info).
 */
export const PAGE_PROBE = `(() => {
  const t = (el) => (el && el.textContent ? el.textContent.replace(/\\s+/g, " ").trim().slice(0, 300) : null);
  const byId = (id) => t(document.getElementById(id));
  const timers = [];
  for (const el of document.querySelectorAll("span,div,p,strong,b,time")) {
    if (timers.length >= 10) break;
    const s = (el.textContent || "").trim();
    if (s.length <= 8 && /^\\d{1,2}:\\d{2}$/.test(s) && el.children.length === 0) {
      const box = el.closest("section,div,aside,header") || el.parentElement;
      timers.push({ value: s, context: t(box) });
    }
  }
  const ld = [];
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    if (ld.length >= 5) break;
    ld.push((s.textContent || "").slice(0, 20000));
  }
  return {
    url: location.href,
    title: document.title.slice(0, 300),
    text: (document.body ? document.body.innerText : "").slice(0, 20000),
    qi: {
      ahead: byId("MainPart_lbUsersInLineAheadOfYou"),
      queueNumber: byId("MainPart_lbQueueNumber"),
      wait: byId("MainPart_lbWhichIsIn"),
      progress: (document.getElementById("MainPart_divProgressbar") || {}).getAttribute
        ? document.getElementById("MainPart_divProgressbar").getAttribute("aria-valuenow")
        : null,
    },
    timers,
    ld,
  };
})()`;

export interface ProbeResult {
  url: string;
  title: string;
  text: string;
  qi?: { ahead: string | null; queueNumber: string | null; wait: string | null; progress: string | null };
  timers?: { value: string; context: string | null }[];
  ld?: string[];
}

export interface EventInfo {
  eventId: string | null;
  eventName: string | null;
  artistName: string | null;
  venueName: string | null;
  startDate: string | null;
}

export interface Reading {
  kind: SiteKind;
  /** People ahead (lower = closer). */
  position: number | null;
  /** 0–100 when the page shows it. */
  progress: number | null;
  /** The page says it's your turn / the queue is done. */
  turn: boolean;
  /** Cart time left in seconds. */
  cartSeconds: number | null;
  event: EventInfo | null;
  stage: "queue" | "event" | "cart" | "other";
}

const num = (s: string | null | undefined): number | null => {
  if (!s) return null;
  const m = /(\d[\d,.\s]*)/.exec(s);
  if (!m) return null;
  const n = Number(m[1]!.replace(/[,.\s]/g, ""));
  return Number.isFinite(n) ? n : null;
};

/** Queue position from Queue-it widgets first, then the page text. */
export function readQueuePosition(p: ProbeResult): number | null {
  const fromWidget = num(p.qi?.ahead);
  if (fromWidget !== null) return fromWidget;
  const text = p.text;
  const patterns = [
    /(?:users?|people|fans?)\s+(?:in\s+line\s+)?ahead\s+of\s+you[^\d]{0,20}(\d[\d,.]*)/i,
    /(\d[\d,.]*)\s+(?:users?|people|fans?)\s+(?:are\s+)?(?:in\s+line\s+)?ahead\s+of\s+you/i,
    /(?:more\s+than\s+)?(\d[\d,.]*)\s+(?:people|fans)\s+in\s+(?:the\s+)?(?:line|queue)/i,
    /your\s+(?:number|place|position)\s+in\s+(?:the\s+)?(?:line|queue)[^\d]{0,20}(\d[\d,.]*)/i,
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) {
      const n = num(m[1]);
      if (n !== null) return n;
    }
  }
  return null;
}

export function readProgress(p: ProbeResult): number | null {
  const fromAttr = num(p.qi?.progress);
  if (fromAttr !== null && fromAttr <= 100) return fromAttr;
  const m = /(\d{1,3})\s?%\s*(?:complete|done|through)?/i.exec(p.text);
  const n = m ? Number(m[1]) : null;
  return n !== null && n <= 100 ? n : null;
}

const TURN = /(it'?s\s+your\s+turn|you'?re\s+(?:through|in)!?|your\s+turn\s+has\s+come|redirecting\s+you\s+(?:now|to))/i;

/** Seconds left on a cart / checkout timer (labelled "time left / remaining / to complete"). */
export function readCartSeconds(p: ProbeResult): number | null {
  const LABEL = /(time\s+(?:left|remaining)|remaining\s+time|complete\s+(?:your\s+)?(?:purchase|checkout|order)|tickets?\s+(?:are\s+)?(?:held|reserved)|expires?\s+in|minutes?\s+to)/i;
  for (const t of p.timers ?? []) {
    if (t.context && LABEL.test(t.context)) return mmss(t.value);
  }
  const m = new RegExp(`${LABEL.source}[^\\d]{0,40}(\\d{1,2}):(\\d{2})`, "i").exec(p.text);
  return m ? Number(m[m.length - 2]) * 60 + Number(m[m.length - 1]) : null;
}

const mmss = (v: string): number | null => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/** Event info from JSON-LD (schema.org Event) + the Ticketmaster event id in the URL. */
export function readEvent(p: ProbeResult): EventInfo | null {
  const eventId = /\/event\/([0-9A-Za-z]{8,32})/.exec(p.url)?.[1] ?? null;
  for (const raw of p.ld ?? []) {
    let j: unknown;
    try {
      j = JSON.parse(raw);
    } catch {
      continue;
    }
    for (const node of flattenLd(j)) {
      const type = String(node["@type"] ?? "");
      if (!/Event$/.test(type)) continue;
      const performer = Array.isArray(node.performer) ? node.performer[0] : node.performer;
      const location = Array.isArray(node.location) ? node.location[0] : node.location;
      return {
        eventId,
        eventName: str(node.name),
        artistName: str((performer as Record<string, unknown> | undefined)?.name),
        venueName: str((location as Record<string, unknown> | undefined)?.name),
        startDate: str(node.startDate),
      };
    }
  }
  return eventId ? { eventId, eventName: p.title || null, artistName: null, venueName: null, startDate: null } : null;
}

function flattenLd(j: unknown): Record<string, unknown>[] {
  if (Array.isArray(j)) return j.flatMap(flattenLd);
  if (j && typeof j === "object") {
    const o = j as Record<string, unknown>;
    return Array.isArray(o["@graph"]) ? [o, ...flattenLd(o["@graph"])] : [o];
  }
  return [];
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, 200) : null);

export function interpretProbe(kind: SiteKind, p: ProbeResult): Reading {
  const cartSeconds = kind === "queue" ? null : readCartSeconds(p);
  const position = kind === "queue" ? readQueuePosition(p) : null;
  const event = readEvent(p);
  const stage: Reading["stage"] =
    kind === "queue" ? "queue" : cartSeconds !== null || /\/(checkout|cart|purchase)\b/i.test(p.url) ? "cart" : event ? "event" : "other";
  return { kind, position, progress: kind === "queue" ? readProgress(p) : null, turn: kind === "queue" && TURN.test(p.text), cartSeconds, event, stage };
}

/**
 * Jancy-style priority: in the cart beats everything (less time left =
 * higher), then the queue (fewer people ahead = higher). Null = leave it.
 */
export function priorityOf(r: Reading): number | null {
  if (r.cartSeconds !== null) return 900_000_000 - r.cartSeconds;
  if (r.position !== null) return 1_000_000 - Math.min(r.position, 999_999);
  return null;
}

/** First configured phrase found on the page (case-insensitive) → its colour. */
export function phraseColour(text: string, phrases: { phrase: string; colour: string }[]): string | null {
  const low = text.toLowerCase();
  for (const p of phrases) if (low.includes(p.phrase.toLowerCase())) return p.colour;
  return null;
}

/**
 * Ticketmaster page actions (opt-in). Element .click() only — synthetic CDP
 * mouse clicks trip bot checks (ENG-INPUT). Each returns what it did.
 */
export const TM_ACTIONS = {
  dismissOverlay: `(() => {
    const d = document.querySelector('[role="dialog"][aria-modal="true"], [data-testid*="modal" i]');
    if (!d) return null;
    const b = [...d.querySelectorAll('button')].find((x) => /^(close|got it|ok|continue to event|accept)$/i.test((x.textContent||'').trim()) || /close/i.test(x.getAttribute('aria-label')||''));
    if (!b || b.closest('form')) return null;
    b.click(); return 'overlay';
  })()`,
  noInsurance: `(() => {
    for (const l of document.querySelectorAll('label')) {
      if (/\\bno\\b.{0,40}(protect|insur|thanks)|decline.{0,20}(protect|insur)/i.test(l.textContent||'')) {
        const i = l.control || l.querySelector('input[type=radio]');
        if (i && i.type === 'radio' && !i.checked) { i.click(); return 'no-insurance'; }
      }
    }
    return null;
  })()`,
  acceptTerms: `(() => {
    for (const l of document.querySelectorAll('label')) {
      if (/(agree|accept).{0,60}terms/i.test(l.textContent||'')) {
        const i = l.control || l.querySelector('input[type=checkbox]');
        if (i && i.type === 'checkbox' && !i.checked) { i.click(); return 'terms'; }
      }
    }
    return null;
  })()`,
} as const;
