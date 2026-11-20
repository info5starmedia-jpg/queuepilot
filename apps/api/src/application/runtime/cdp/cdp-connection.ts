/**
 * Minimal CDP (Chrome DevTools Protocol) JSON-RPC client over WebSocket.
 *
 * Dependency-free on purpose: Node >= 22 ships a global WebSocket client, and
 * QueuePilot only needs request/response calls (Target.*) — no event
 * subscriptions. Firefox-family engines (camoufox) expose this same CDP
 * surface on their remote-debugging port for Puppeteer compatibility.
 */

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class CdpError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "CdpError";
  }
}

export class CdpConnection {
  private nextId = 1;
  private readonly pending = new Map<number, PendingCall>();
  private closed = false;

  private constructor(private readonly ws: WebSocket) {}

  /**
   * Concrete browser-target WebSocket URL for engines that publish a bare
   * `ws://host:port` endpoint. Real Chromium (and the Firefox CDP-compat
   * surface) only upgrades WebSocket on `/devtools/browser/<id>` — the bare
   * root gets a rejected upgrade with an empty reason, which surfaces as the
   * unhelpful "CDP connection error on ws://…: ". Resolving via
   * `/json/version` first fixes every consumer (cookies, autofill, tab
   * tiling, bundles) at the connection layer. Any failure falls back to the
   * original URL so behaviour against non-conforming endpoints is unchanged.
   */
  private static async resolveEndpoint(url: string, timeoutMs: number): Promise<string> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return url;
    }
    const path = parsed.pathname.replace(/\/+$/, "");
    if (path) return url; // already a concrete target path (e.g. /devtools/browser/…)
    const httpVersion = `http://${parsed.host}/json/version`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Math.min(timeoutMs, 5_000));
    try {
      const res = await fetch(httpVersion, { signal: ctrl.signal });
      if (res.ok) {
        const info = (await res.json()) as { webSocketDebuggerUrl?: string };
        if (typeof info.webSocketDebuggerUrl === "string" && info.webSocketDebuggerUrl) {
          return info.webSocketDebuggerUrl;
        }
      }
    } catch {
      /* not a DevTools HTTP endpoint — use the URL as given */
    } finally {
      clearTimeout(timer);
    }
    return url;
  }

  static async connect(url: string, timeoutMs = 10_000): Promise<CdpConnection> {
    const resolved = await CdpConnection.resolveEndpoint(url, timeoutMs);
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(resolved);
      const conn = new CdpConnection(ws);
      const timer = setTimeout(() => {
        reject(new Error(`CDP connect timeout after ${timeoutMs}ms: ${resolved}`));
        try {
          ws.close();
        } catch {
          /* already gone */
        }
      }, timeoutMs);

      ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve(conn);
      });
      ws.addEventListener("error", (ev) => {
        clearTimeout(timer);
        const err = new Error(
          `CDP connection error on ${resolved}: ${(ev as { message?: string }).message ?? "unknown"}`,
        );
        if (!conn.closed && conn.pending.size === 0) reject(err);
        conn.failAll(err);
      });
      ws.addEventListener("close", () => {
        conn.closed = true;
        conn.failAll(new Error("CDP connection closed"));
      });
      ws.addEventListener("message", (ev) => {
        conn.onMessage(String((ev as MessageEvent).data));
      });
    });
  }

  /** One JSON-RPC call. Rejects with CdpError on a protocol-level error. */
  call<T>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 15_000,
    sessionId?: string,
  ): Promise<T> {
    if (this.closed)
      return Promise.reject(new Error("CDP connection is closed"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP call ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      this.ws.send(
        JSON.stringify(
          sessionId ? { id, method, params, sessionId } : { id, method, params },
        ),
      );
    });
  }

  private readonly listeners = new Set<(method: string, params: Record<string, unknown>, sessionId?: string) => void>();

  /** J8: subscribe to protocol events (the network logger). Returns an unsubscribe. */
  onEvent(cb: (method: string, params: Record<string, unknown>, sessionId?: string) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  close(): void {
    this.closed = true;
    this.failAll(new Error("CDP connection closed"));
    try {
      this.ws.close();
    } catch {
      /* already gone */
    }
  }

  private onMessage(data: string): void {
    let msg: {
      id?: number;
      result?: unknown;
      error?: { code: number; message: string };
      method?: string;
      params?: Record<string, unknown>;
      sessionId?: string;
    };
    try {
      msg = JSON.parse(data);
    } catch {
      return; // not JSON — not for us
    }
    if (typeof msg.id !== "number") {
      if (msg.method) for (const cb of this.listeners) cb(msg.method, msg.params ?? {}, msg.sessionId);
      return;
    }
    const call = this.pending.get(msg.id);
    if (!call) return;
    this.pending.delete(msg.id);
    clearTimeout(call.timer);
    if (msg.error) {
      call.reject(new CdpError(msg.error.code, msg.error.message));
    } else {
      call.resolve(msg.result);
    }
  }

  private failAll(err: Error): void {
    for (const call of this.pending.values()) {
      clearTimeout(call.timer);
      call.reject(err);
    }
    this.pending.clear();
  }
}
