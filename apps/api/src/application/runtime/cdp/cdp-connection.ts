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

  static connect(url: string, timeoutMs = 10_000): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const conn = new CdpConnection(ws);
      const timer = setTimeout(() => {
        reject(new Error(`CDP connect timeout after ${timeoutMs}ms: ${url}`));
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
          `CDP connection error on ${url}: ${(ev as { message?: string }).message ?? "unknown"}`,
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
      this.ws.send(JSON.stringify({ id, method, params }));
    });
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
    };
    try {
      msg = JSON.parse(data);
    } catch {
      return; // not JSON — not for us
    }
    if (typeof msg.id !== "number") return; // events have no id; we don't subscribe
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
