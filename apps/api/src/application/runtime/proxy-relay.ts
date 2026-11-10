import net from "node:net";
import tls from "node:tls";
import { DomainError, ErrorCodes } from "@queuepilot/contracts";

/**
 * Auth-injecting loopback relay — the fix for the P0 proxy leak.
 *
 * Chromium ignores credentials embedded in --proxy-server (user:pass@host is
 * silently stripped upstream), so an authenticated proxy can never be honored
 * through the flag alone. AliasMode's proven answer, re-implemented: the
 * engine gets --proxy-server=http://127.0.0.1:<port>, and this relay forwards
 * to the real upstream proxy, injecting Proxy-Authorization itself.
 *
 * Design rules (house rules apply here too):
 * - Refuse loudly: unsupported upstream schemes throw PROXY_UNSUPPORTED at
 *   start, never a silent direct fallback.
 * - Loopback only: the relay binds 127.0.0.1 and nothing else.
 * - Fail closed: if the upstream rejects the tunnel (407 etc.) the client
 *   gets the failure verbatim — traffic NEVER detours around the proxy.
 * - Correct over fast: plain-HTTP requests are forced to Connection: close
 *   so every forwarded request carries auth (no keep-alive ambiguity).
 */

export interface ProxyRelayStats {
  /** CONNECT tunnels established end-to-end. */
  tunnels: number;
  /** Plain-HTTP requests forwarded. */
  requests: number;
  /** Times upstream refused the tunnel (non-200 to our CONNECT). */
  rejected: number;
  /** Times upstream was unreachable. */
  upstreamErrors: number;
}

export interface ProxyRelay {
  readonly port: number;
  readonly upstream: string;
  readonly stats: ProxyRelayStats;
  close(): Promise<void>;
}

interface UpstreamSpec {
  protocol: "http" | "https";
  host: string;
  port: number;
  /** base64("user:pass") or null when the upstream needs no auth. */
  authBasic: string | null;
  /** Redacted label for logs/errors — never contains credentials. */
  label: string;
}

export function parseUpstream(proxyUrl: string): UpstreamSpec {
  let url: URL;
  try {
    url = new URL(proxyUrl);
  } catch {
    throw new DomainError(
      ErrorCodes.PROXY_UNSUPPORTED,
      `proxy URL is not parseable: ${JSON.stringify(String(proxyUrl).slice(0, 40))}`,
    );
  }
  const protocol = url.protocol.replace(":", "");
  if (protocol !== "http" && protocol !== "https") {
    throw new DomainError(
      ErrorCodes.PROXY_UNSUPPORTED,
      `proxy scheme "${url.protocol}" is not supported by the relay yet ` +
        `(http/https upstreams only; socks5 is refused loudly, never bypassed)`,
    );
  }
  const auth =
    url.username !== ""
      ? Buffer.from(
          `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`,
        ).toString("base64")
      : null;
  return {
    protocol,
    host: url.hostname,
    port: url.port ? Number(url.port) : protocol === "https" ? 443 : 80,
    authBasic: auth,
    label: `${protocol}://${url.hostname}:${url.port ? Number(url.port) : protocol === "https" ? 443 : 80}`,
  };
}

const HEAD_LIMIT = 64 * 1024;
const UPSTREAM_TIMEOUT_MS = 15_000;

/** Read one HTTP head (through \r\n\r\n) from a socket. */
function readHead(socket: net.Socket, limit = HEAD_LIMIT): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf("\r\n\r\n");
      if (end !== -1) {
        cleanup();
        // Any body bytes already read are kept by leaving the listener detached
        // and pushing the remainder back for the pipe phase.
        const rest = buf.subarray(end + 4);
        if (rest.length > 0) socket.unshift(rest);
        resolve(buf.subarray(0, end + 4));
      } else if (buf.length > limit) {
        cleanup();
        reject(new Error("head exceeds limit"));
      }
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onEnd = () => {
      cleanup();
      reject(new Error("socket ended before head completed"));
    };
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("end", onEnd);
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("end", onEnd);
  });
}

function connectUpstream(up: UpstreamSpec): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const onTimeout = () => {
      socket.destroy();
      reject(new Error(`upstream ${up.label} connect timeout`));
    };
    const socket: net.Socket =
      up.protocol === "https"
        ? tls.connect({ host: up.host, port: up.port, servername: up.host })
        : net.connect({ host: up.host, port: up.port });
    socket.setTimeout(UPSTREAM_TIMEOUT_MS);
    socket.once("timeout", onTimeout);
    socket.once(up.protocol === "https" ? "secureConnect" : "connect", () => {
      socket.setTimeout(0);
      socket.off("timeout", onTimeout);
      resolve(socket);
    });
    socket.once("error", (err) => {
      socket.setTimeout(0);
      socket.off("timeout", onTimeout);
      reject(err);
    });
  });
}

function authHeader(up: UpstreamSpec): string {
  return up.authBasic ? `Proxy-Authorization: Basic ${up.authBasic}\r\n` : "";
}

export async function startProxyRelay(proxyUrl: string): Promise<ProxyRelay> {
  const up = parseUpstream(proxyUrl);
  const stats: ProxyRelayStats = {
    tunnels: 0,
    requests: 0,
    rejected: 0,
    upstreamErrors: 0,
  };

  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    sockets.add(client);
    client.once("close", () => sockets.delete(client));
    client.once("error", () => client.destroy());
    readHead(client)
      .then((head) => void handleClient(client, head))
      .catch(() => client.destroy());
  });

  async function handleClient(client: net.Socket, head: Buffer): Promise<void> {
    const firstLine = head.subarray(0, head.indexOf("\r\n")).toString("latin1");
    const method = firstLine.split(" ")[0] ?? "";

    let upstream: net.Socket;
    try {
      upstream = await connectUpstream(up);
    } catch {
      stats.upstreamErrors++;
      client.write("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
      client.destroy();
      return;
    }
    upstream.once("error", () => {
      client.destroy();
      upstream.destroy();
    });
    // Engine gone = tunnel gone; never leave an upstream socket lingering.
    client.once("close", () => upstream.destroy());

    if (method === "CONNECT") {
      const target = firstLine.split(" ")[1] ?? "";
      upstream.write(
        `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${authHeader(up)}\r\n`,
      );
      try {
        const respHead = await readHead(upstream);
        const statusLine = respHead
          .subarray(0, respHead.indexOf("\r\n"))
          .toString("latin1");
        if (!/^HTTP\/1\.[01] 200\b/.test(statusLine)) {
          stats.rejected++;
          // Fail closed: hand the refusal to the client verbatim.
          client.write(respHead);
          client.destroy();
          upstream.destroy();
          return;
        }
      } catch {
        stats.upstreamErrors++;
        client.write("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
        client.destroy();
        upstream.destroy();
        return;
      }
      stats.tunnels++;
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      client.pipe(upstream).pipe(client);
      return;
    }

    // Plain HTTP (absolute-form). Inject auth, force Connection: close so
    // every request on a new client connection carries it.
    const headText = head.toString("latin1");
    const rewritten = headText
      .split("\r\n")
      .filter(
        (line) => !/^(proxy-authorization|proxy-connection|connection):/i.test(line),
      )
      .join("\r\n")
      .replace("\r\n\r\n", `\r\n${authHeader(up)}Connection: close\r\n\r\n`);
    upstream.write(rewritten, "latin1");
    stats.requests++;
    client.pipe(upstream).pipe(client);
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("relay has no address");
  }
  let closed: Promise<void> | null = null;
  return {
    port: address.port,
    upstream: up.label,
    stats,
    close: () => {
      // Idempotent: FurySession calls close from both stop() and the
      // engine-exit path; the second call must be a no-op, not an error.
      if (!closed) {
        closed = new Promise((resolve) => {
          // Stop accepting, then end the active tunnels — the engine is gone
          // by the time close() is called, so no live traffic depends on them.
          server.close(() => resolve());
          for (const socket of sockets) socket.destroy();
        });
      }
      return closed;
    },
  };
}
