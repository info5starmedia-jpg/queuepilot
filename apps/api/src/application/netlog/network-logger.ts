import fs from "node:fs";
import path from "node:path";
import { DomainError, ErrorCodes } from "@queuepilot/contracts";
import { CdpConnection } from "../runtime/cdp/cdp-connection.js";

/**
 * J8 — network logger (Jancy's net-export). Records every request of a
 * running profile to `<dataDir>/netlogs/<profile>-<time>.ndjson`, one JSON
 * object per event, until stopped or the size cap is hit.
 *
 * Privacy modes (what leaves the page's network stack into the file):
 *   strip      private data removed: cookies, Authorization, Set-Cookie,
 *              query strings and request bodies are never written (default)
 *   cookies    as strip, but cookie headers are kept
 *   everything every header and the full URL
 * The file is local, never uploaded; responses of the API never include it.
 */

export type NetLogMode = "strip" | "cookies" | "everything";

interface Active {
  conn: CdpConnection;
  file: string;
  bytes: number;
  events: number;
  max: number;
  mode: NetLogMode;
  stopped: boolean;
}

const PRIVATE_HEADERS = /^(cookie|set-cookie|authorization|proxy-authorization|x-csrf.*|x-xsrf.*)$/i;
const COOKIE_HEADERS = /^(cookie|set-cookie)$/i;

export function sanitizeHeaders(h: unknown, mode: NetLogMode): Record<string, unknown> {
  if (!h || typeof h !== "object" || mode === "everything") return (h as Record<string, unknown>) ?? {};
  const drop = mode === "strip" ? PRIVATE_HEADERS : /^(authorization|proxy-authorization)$/i;
  const kept = Object.entries(h as Record<string, unknown>).filter(([k]) => !drop.test(k) && !(mode === "strip" && COOKIE_HEADERS.test(k)));
  // Referer / Location carry the query string of another URL: strip it there too.
  return Object.fromEntries(kept.map(([k, v]) => [k, mode === "strip" && /^(referer|location)$/i.test(k) ? sanitizeUrl(v, mode) : v]));
}

export function sanitizeUrl(url: unknown, mode: NetLogMode): string {
  const s = typeof url === "string" ? url.slice(0, 2000) : "";
  return mode === "everything" ? s : s.split(/[?#]/)[0]!;
}

export class NetworkLogger {
  private readonly active = new Map<string, Active>();

  constructor(private readonly dataDir: string) {}

  status(profileId: string): { active: boolean; file?: string; bytes?: number; events?: number; mode?: NetLogMode } {
    const a = this.active.get(profileId);
    return a ? { active: true, file: path.basename(a.file), bytes: a.bytes, events: a.events, mode: a.mode } : { active: false };
  }

  async start(profileId: string, wsEndpoint: string, opts: { mode: NetLogMode; maxBytes: number }): Promise<ReturnType<NetworkLogger["status"]>> {
    if (this.active.has(profileId)) throw new DomainError(ErrorCodes.CONFLICT, "the network logger is already running for this profile");
    const dir = path.join(this.dataDir, "netlogs");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${profileId}-${new Date().toISOString().replace(/[:.]/g, "-")}.ndjson`);
    const conn = await CdpConnection.connect(wsEndpoint, 10_000);
    const a: Active = { conn, file, bytes: 0, events: 0, max: opts.maxBytes, mode: opts.mode, stopped: false };
    this.active.set(profileId, a);
    conn.onEvent((method, params, sessionId) => {
      if (method === "Target.attachedToTarget") {
        const info = params.targetInfo as { type?: string } | undefined;
        const sid = params.sessionId as string | undefined;
        if (sid && (info?.type === "page" || info?.type === "service_worker")) void conn.call("Network.enable", {}, 10_000, sid).catch(() => {});
        return;
      }
      if (sessionId) this.record(profileId, a, method, params);
    });
    try {
      await conn.call("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
      // Pages that already exist are not "auto attached": attach to each so they log too.
      const { targetInfos } = await conn.call<{ targetInfos: { targetId: string; type: string }[] }>("Target.getTargets");
      for (const t of targetInfos.filter((x) => x.type === "page")) {
        const { sessionId } = await conn.call<{ sessionId: string }>("Target.attachToTarget", { targetId: t.targetId, flatten: true });
        await conn.call("Network.enable", {}, 10_000, sessionId);
      }
    } catch (e) {
      this.stop(profileId);
      throw e;
    }
    return this.status(profileId);
  }

  stop(profileId: string): ReturnType<NetworkLogger["status"]> & { stopped: boolean } {
    const a = this.active.get(profileId);
    if (!a) return { active: false, stopped: false };
    a.stopped = true;
    this.active.delete(profileId);
    a.conn.close();
    return { active: false, stopped: true, file: path.basename(a.file), bytes: a.bytes, events: a.events, mode: a.mode };
  }

  private record(profileId: string, a: Active, method: string, p: Record<string, unknown>): void {
    let row: Record<string, unknown> | null = null;
    const t = new Date().toISOString();
    if (method === "Network.requestWillBeSent") {
      const r = (p.request ?? {}) as Record<string, unknown>;
      row = { t, ev: "request", id: p.requestId, method: r.method, url: sanitizeUrl(r.url, a.mode), type: p.type, headers: sanitizeHeaders(r.headers, a.mode) };
    } else if (method === "Network.responseReceived") {
      const r = (p.response ?? {}) as Record<string, unknown>;
      row = { t, ev: "response", id: p.requestId, url: sanitizeUrl(r.url, a.mode), status: r.status, mime: r.mimeType, headers: sanitizeHeaders(r.headers, a.mode) };
    } else if (method === "Network.loadingFailed") {
      row = { t, ev: "failed", id: p.requestId, error: p.errorText };
    }
    if (!row) return;
    const line = `${JSON.stringify(row)}\n`;
    if (a.bytes + line.length > a.max) {
      this.stop(profileId); // size cap reached: the file is complete up to here
      return;
    }
    fs.appendFileSync(a.file, line);
    a.bytes += line.length;
    a.events++;
  }
}
