import fs from "node:fs";
import path from "node:path";
import type { LifecycleEvent, Profile, SitesSettings } from "@queuepilot/contracts";
import { CdpConnection } from "../runtime/cdp/cdp-connection.js";
import type { TabStateService } from "../tabs/tab-state.service.js";
import {
  PAGE_PROBE,
  TM_ACTIONS,
  interpretProbe,
  phraseColour,
  priorityOf,
  siteKindOf,
  type EventInfo,
  type ProbeResult,
  type Reading,
} from "./extractors.js";

/**
 * J6 — site plug-ins. Every few seconds, for each running profile: list its
 * page targets, and ONLY for tabs on a known site (queue / Ticketmaster /
 * AXS / Etix / SeatGeek) run the read-only probe in an isolated world. The
 * reading lands in the profile's tab state (queue position, cart timer,
 * event, stage → priority / group), new positions go to the queue-position
 * log, and stage changes are emitted as events (console SSE + Discord).
 */

/** Jancy's QueuePosition record (nitrane/jancy-example-queue-position-sink). */
export interface QueuePosition {
  timestampMsecs: number;
  profileId: string;
  position: number;
  eventData: { eventId: string | null; eventName: string | null; artistName: string | null; venueName: string | null } | null;
  url: string;
  emailAddress: string | null;
  /** Proxy NAME only — never host credentials. */
  proxyStr: string | null;
}

/** How the service reaches pages (CDP in production, a fake in tests). */
export interface PageAccess {
  listPages(wsEndpoint: string): Promise<{ targetId: string; url: string }[]>;
  /** Evaluates in an isolated world of the target; returns the by-value result. */
  evaluate(wsEndpoint: string, targetId: string, expression: string): Promise<unknown>;
}

export interface SitePluginDeps {
  profiles: { list(): Profile[]; get(id: string): Profile };
  lifecycle: {
    activeRun(profileId: string): { id: string; status: string; wsEndpoint?: string | null } | null;
    events: { emit(name: "lifecycle", e: LifecycleEvent): unknown };
  };
  tabState: TabStateService;
  settings: () => SitesSettings;
  dataDir: string;
  proxyName?: (proxyId: string) => string | null;
  pages?: PageAccess;
  now?: () => number;
}

interface Memory {
  stage: Reading["stage"] | null;
  lastQueueAt: number;
  position: number | null;
  passedSent: boolean;
  cartSent: boolean;
}

export class SitePluginService {
  private readonly pages: PageAccess;
  private readonly memory = new Map<string, Memory>();
  private readonly buffer: QueuePosition[] = [];
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(private readonly deps: SitePluginDeps) {
    this.pages = deps.pages ?? cdpPageAccess;
  }

  start(): void {
    const loop = () => {
      const s = this.deps.settings();
      this.timer = setTimeout(async () => {
        await this.tick().catch(() => {});
        loop();
      }, s.extractorIntervalSec * 1000);
      this.timer.unref?.();
    };
    loop();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** The in-memory queue-position log (newest last), optionally for one profile. */
  positions(profileId?: string): QueuePosition[] {
    return profileId ? this.buffer.filter((p) => p.profileId === profileId) : [...this.buffer];
  }

  /** One pass over every running profile. Exposed for tests. */
  async tick(): Promise<void> {
    const s = this.deps.settings();
    if (!s.extractorsEnabled || this.busy) return;
    this.busy = true;
    try {
      for (const p of this.deps.profiles.list()) {
        const run = this.deps.lifecycle.activeRun(p.id);
        if (!run || run.status !== "running" || !run.wsEndpoint) {
          this.memory.delete(p.id);
          continue;
        }
        await this.readProfile(p, run.id, run.wsEndpoint, s).catch(() => {});
      }
    } finally {
      this.busy = false;
    }
  }

  private async readProfile(p: Profile, runId: string, ws: string, s: SitesSettings): Promise<void> {
    const targets = (await this.pages.listPages(ws)).filter((t) => siteKindOf(t.url) !== null).slice(0, 20);
    const readings: { r: Reading; url: string; text: string }[] = [];
    for (const t of targets) {
      const kind = siteKindOf(t.url)!;
      const raw = (await this.pages.evaluate(ws, t.targetId, PAGE_PROBE).catch(() => null)) as ProbeResult | null;
      if (!raw || typeof raw.text !== "string") continue;
      readings.push({ r: interpretProbe(kind, raw), url: raw.url, text: raw.text });
      if (kind === "ticketmaster") await this.pageActions(ws, t.targetId, s);
    }
    const now = (this.deps.now ?? Date.now)();
    const mem = this.memory.get(p.id) ?? { stage: null, lastQueueAt: 0, position: null, passedSent: false, cartSent: false };
    if (readings.length === 0) {
      this.memory.set(p.id, mem);
      return;
    }
    // Best tab: in the cart first, then the queue tab with the fewest ahead, then anything.
    const best =
      readings.find((x) => x.r.stage === "cart") ??
      readings.filter((x) => x.r.position !== null).sort((a, b) => a.r.position! - b.r.position!)[0] ??
      readings.find((x) => x.r.stage === "queue") ??
      readings[0]!;
    const r = best.r;
    const event: EventInfo | null = readings.map((x) => x.r.event).find((e) => e !== null) ?? null;

    const data: Record<string, string | number | boolean | null> = {
      stage: r.stage,
      site: r.kind,
      queuePosition: r.position,
      queueProgress: r.progress,
      cartTimer: r.cartSeconds === null ? null : `${Math.floor(r.cartSeconds / 60)}:${String(r.cartSeconds % 60).padStart(2, "0")}`,
      eventId: event?.eventId ?? null,
      eventName: event?.eventName ?? null,
      artistName: event?.artistName ?? null,
      venueName: event?.venueName ?? null,
    };
    const colour = s.eventPhrases.length ? phraseColour(readings.map((x) => x.text).join("\n"), s.eventPhrases) : null;
    this.deps.tabState.patch(p.id, {
      data,
      priority: priorityOf(r),
      priorityGroup: r.stage,
      ...(colour ? { colour } : {}),
    });

    // Events + the queue-position log.
    if (r.stage === "queue") {
      mem.lastQueueAt = now;
      mem.passedSent = false;
      if (r.position !== null && r.position !== mem.position) {
        mem.position = r.position;
        this.record(p, best.url, r.position, event, now, s);
        this.emit(p.id, runId, "queue.position", `${r.position} ahead${event?.eventName ? ` · ${event.eventName}` : ""}`);
      }
    }
    const left = mem.stage === "queue" && r.stage !== "queue" && now - mem.lastQueueAt < 10 * 60_000;
    if (!mem.passedSent && (r.turn || left)) {
      mem.passedSent = true;
      this.emit(p.id, runId, "queue.passed", `${event?.eventName ?? hostOf(best.url)}`);
    }
    if (r.stage === "cart" && !mem.cartSent) {
      mem.cartSent = true;
      this.emit(p.id, runId, "cart.timer", `${data.cartTimer ?? "?"} left${event?.eventName ? ` · ${event.eventName}` : ""}`);
    }
    if (r.stage !== "cart") mem.cartSent = false;
    mem.stage = r.stage;
    this.memory.set(p.id, mem);
  }

  private async pageActions(ws: string, targetId: string, s: SitesSettings): Promise<void> {
    const wanted: string[] = [];
    if (s.tmDismissOverlay) wanted.push(TM_ACTIONS.dismissOverlay);
    if (s.tmAutoNoInsurance) wanted.push(TM_ACTIONS.noInsurance);
    if (s.tmAutoTerms) wanted.push(TM_ACTIONS.acceptTerms);
    for (const expr of wanted) await this.pages.evaluate(ws, targetId, expr).catch(() => null);
  }

  private record(p: Profile, url: string, position: number, event: EventInfo | null, now: number, s: SitesSettings): void {
    const rec: QueuePosition = {
      timestampMsecs: now,
      profileId: p.id,
      position,
      eventData: event ? { eventId: event.eventId, eventName: event.eventName, artistName: event.artistName, venueName: event.venueName } : null,
      url,
      emailAddress: p.email,
      proxyStr: p.proxyId ? (this.deps.proxyName?.(p.proxyId) ?? null) : null,
    };
    this.buffer.push(rec);
    if (this.buffer.length > 1000) this.buffer.splice(0, this.buffer.length - 1000);
    if (s.queuePositionCsv) {
      try {
        const dir = path.join(this.deps.dataDir, "queue-positions");
        fs.mkdirSync(dir, { recursive: true });
        const name = (event?.eventId ?? "unknown").replace(/[^\w-]/g, "_").slice(0, 64) || "unknown";
        const file = path.join(dir, `${name}.csv`);
        const head = fs.existsSync(file) ? "" : "time,profile,email,position,eventId,eventName,artist,venue,proxy,url\r\n";
        const row = [new Date(now).toISOString(), p.name, p.email ?? "", position, event?.eventId ?? "", event?.eventName ?? "", event?.artistName ?? "", event?.venueName ?? "", rec.proxyStr ?? "", url]
          .map(csvCell)
          .join(",");
        fs.appendFileSync(file, `${head}${row}\r\n`, "utf8");
      } catch {
        /* the log is best-effort; never break the loop */
      }
    }
  }

  private emit(profileId: string, runId: string, type: LifecycleEvent["type"], detail: string): void {
    this.deps.lifecycle.events.emit("lifecycle", {
      type,
      profileId,
      runId,
      at: new Date((this.deps.now ?? Date.now)()).toISOString(),
      detail: detail.slice(0, 500),
    });
  }
}

const hostOf = (u: string): string => {
  try {
    return new URL(u).hostname;
  } catch {
    return "site";
  }
};

function csvCell(v: unknown): string {
  let s = String(v ?? "");
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Production PageAccess: CDP over the run's browser endpoint, isolated world per call. */
export const cdpPageAccess: PageAccess = {
  async listPages(ws) {
    const conn = await CdpConnection.connect(ws);
    try {
      const r = await conn.call<{ targetInfos?: { targetId: string; type: string; url: string }[] }>("Target.getTargets", {}, 10_000);
      return (r.targetInfos ?? []).filter((t) => t.type === "page").map((t) => ({ targetId: t.targetId, url: t.url }));
    } finally {
      conn.close();
    }
  },
  async evaluate(ws, targetId, expression) {
    const conn = await CdpConnection.connect(ws);
    try {
      const { sessionId } = await conn.call<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true }, 10_000);
      try {
        const tree = await conn.call<{ frameTree: { frame: { id: string } } }>("Page.getFrameTree", {}, 10_000, sessionId);
        const world = await conn.call<{ executionContextId: number }>(
          "Page.createIsolatedWorld",
          { frameId: tree.frameTree.frame.id, worldName: "qp-sites", grantUniveralAccess: false },
          10_000,
          sessionId,
        );
        const r = await conn.call<{ result?: { value?: unknown }; exceptionDetails?: unknown }>(
          "Runtime.evaluate",
          { expression, contextId: world.executionContextId, returnByValue: true, timeout: 5_000 },
          10_000,
          sessionId,
        );
        return r.exceptionDetails ? null : (r.result?.value ?? null);
      } finally {
        await conn.call("Target.detachFromTarget", { sessionId }, 5_000).catch(() => {});
      }
    } finally {
      conn.close();
    }
  },
};
