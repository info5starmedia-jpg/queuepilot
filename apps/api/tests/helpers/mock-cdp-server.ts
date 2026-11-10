import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";

export interface CdpCall {
  id: number;
  method: string;
  params: Record<string, unknown>;
}

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/**
 * Minimal mock CDP engine: an HTTP server that answers /json/version and a
 * hand-rolled RFC6455 WebSocket endpoint speaking just enough of the Target
 * domain to test CdpTabController — no ws dependency.
 *
 * Set `supportsContexts: false` to simulate an engine without
 * Target.createBrowserContext (isolation unsupported).
 */
export class MockCdpServer {
  readonly calls: CdpCall[] = [];
  supportsContexts = true;
  private server: http.Server;
  private readonly sockets = new Set<net.Socket>();
  private nextContext = 0;
  private nextTarget = 0;
  private port = 0;

  constructor() {
    this.server = http.createServer((req, res) => {
      if (req.url === "/json/version") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            Browser: "mock-cdp/1.0",
            webSocketDebuggerUrl: `ws://127.0.0.1:${this.port}/devtools/browser/mock`,
          }),
        );
        return;
      }
      res.writeHead(404).end();
    });
    this.server.on("upgrade", (req, socket) =>
      this.onUpgrade(req, socket as net.Socket),
    );
  }

  start(): Promise<{ port: number; wsUrl: string }> {
    return new Promise((resolve) => {
      this.server.listen(0, "127.0.0.1", () => {
        const addr = this.server.address();
        this.port = typeof addr === "object" && addr ? addr.port : 0;
        resolve({
          port: this.port,
          wsUrl: `ws://127.0.0.1:${this.port}/devtools/browser/mock`,
        });
      });
    });
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  callsFor(method: string): CdpCall[] {
    return this.calls.filter((c) => c.method === method);
  }

  private onUpgrade(req: http.IncomingMessage, socket: net.Socket): void {
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));
    const key = req.headers["sec-websocket-key"] ?? "";
    const accept = crypto
      .createHash("sha1")
      .update(key + WS_GUID)
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );

    let buf = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const frame = readFrame(buf);
        if (!frame) break;
        buf = buf.subarray(frame.consumed);
        this.onFrame(socket, frame.opcode, frame.payload);
      }
    });
  }

  private onFrame(socket: net.Socket, opcode: number, payload: Buffer): void {
    if (opcode === 0x8) {
      socket.end();
      return;
    }
    if (opcode === 0x9) {
      socket.write(encodeFrame(0xa, payload)); // ping -> pong
      return;
    }
    if (opcode !== 0x1) return;

    let msg: { id?: number; method?: string; params?: Record<string, unknown> };
    try {
      msg = JSON.parse(payload.toString("utf8"));
    } catch {
      return;
    }
    if (typeof msg.id !== "number" || typeof msg.method !== "string") return;
    const call: CdpCall = {
      id: msg.id,
      method: msg.method,
      params: msg.params ?? {},
    };
    this.calls.push(call);
    socket.write(
      encodeFrame(0x1, Buffer.from(JSON.stringify(this.answer(call)), "utf8")),
    );
  }

  private answer(call: CdpCall): object {
    const { id, method, params } = call;
    switch (method) {
      case "Target.createBrowserContext":
        if (!this.supportsContexts) {
          return {
            id,
            error: {
              code: -32601,
              message: "Target.createBrowserContext not found",
            },
          };
        }
        return {
          id,
          result: { browserContextId: `ctx-${++this.nextContext}` },
        };
      case "Target.createTarget":
        return {
          id,
          result: { targetId: `target-${++this.nextTarget}` },
        };
      case "Target.closeTarget":
        return { id, result: { success: true } };
      case "Target.disposeBrowserContext":
        return { id, result: {} };
      default:
        return { id, error: { code: -32601, message: `${method} not found` } };
    }
  }
}

interface Frame {
  opcode: number;
  payload: Buffer;
  consumed: number;
}

/** Parse one complete frame from the front of buf; null if incomplete. */
function readFrame(buf: Buffer): Frame | null {
  if (buf.length < 2) return null;
  const opcode = buf[0]! & 0x0f;
  const masked = (buf[1]! & 0x80) !== 0;
  let len = buf[1]! & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }
  const maskOffset = offset;
  if (masked) offset += 4;
  if (buf.length < offset + len) return null;
  let payload = buf.subarray(offset, offset + len);
  if (masked) {
    const mask = buf.subarray(maskOffset, maskOffset + 4);
    const unmasked = Buffer.alloc(len);
    for (let i = 0; i < len; i++) unmasked[i] = payload[i]! ^ mask[i % 4]!;
    payload = unmasked;
  }
  return { opcode, payload, consumed: offset + len };
}

/** Server-to-client frames are never masked. */
function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}
