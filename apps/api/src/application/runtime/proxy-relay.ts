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
  protocol: "http" | "https" | "socks5";
  host: string;
  port: number;
  /** base64("user:pass") or null when the upstream needs no auth. */
  authBasic: string | null;
  /** Decoded user/pass for SOCKS5 RFC 1929 auth, null when none. */
  authSocks: { user: string; pass: string } | null;
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
  const raw = url.protocol.replace(":", "");
  if (raw !== "http" && raw !== "https" && raw !== "socks5" && raw !== "socks5h") {
    throw new DomainError(
      ErrorCodes.PROXY_UNSUPPORTED,
      `proxy scheme "${url.protocol}" is not supported by the relay ` +
        `(http/https/socks5 only; unknown schemes are refused loudly, never bypassed)`,
    );
  }
  // We always remote-resolve hostnames at the upstream (socks5h semantics),
  // so the two spellings are identical here.
  const protocol: UpstreamSpec["protocol"] = raw === "socks5h" ? "socks5" : raw;
  const user = url.username !== "" ? decodeURIComponent(url.username) : null;
  const pass = decodeURIComponent(url.password);
  // Auth material is protocol-specific: Basic header for http/https, RFC 1929
  // user/pass for socks5. Never carry one protocol's auth into the other.
  const authBasic =
    user !== null && (protocol === "http" || protocol === "https")
      ? Buffer.from(`${user}:${pass}`).toString("base64")
      : null;
  const authSocks =
    user !== null && protocol === "socks5" ? { user, pass } : null;
  const port = url.port
    ? Number(url.port)
    : protocol === "https" ? 443 : protocol === "socks5" ? 1080 : 80;
  return {
    protocol,
    host: url.hostname,
    port,
    authBasic,
    authSocks,
    label: `${protocol}://${url.hostname}:${port}`,
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

/**
 * SOCKS5 CONNECT per RFC 1928 + 1929, returning a socket ready for piping.
 * We always remote-resolve at the upstream (socks5h semantics), so the
 * address field carries the original hostname (ATYP 0x03) unless the caller
 * passed a literal IP (0x01 IPv4 / 0x04 IPv6).
 */
function socks5Connect(
  up: UpstreamSpec,
  targetHost: string,
  targetPort: number,
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: up.host, port: up.port });
    socket.setTimeout(UPSTREAM_TIMEOUT_MS);
    let settled = false;

    /** Read exactly n bytes; over-read bytes are pushed back before resolve. */
    /**
     * Session reader for the handshake: ONE persistent data listener with an
     * accumulating buffer. (The unshift-then-reattach pattern hangs on modern
     * Node — a socket that loses its last 'data' listener pauses, and unshifted
     * bytes are not re-emitted to the next listener. unshift-then-pipe is fine,
     * so the leftover is pushed back once, at the very end, before piping.)
     */
    let pending = Buffer.alloc(0);
    let waiter: { n: number; res: (b: Buffer) => void; rej: (e: Error) => void } | null = null;
    const onHandshakeData = (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      if (waiter && pending.length >= waiter.n) {
        const w = waiter;
        waiter = null;
        w.res(pending.subarray(0, w.n));
        pending = pending.subarray(w.n);
      }
    };
    const onHandshakeError = (err: Error) => {
      if (waiter) {
        const w = waiter;
        waiter = null;
        w.rej(err);
      }
    };
    socket.on("data", onHandshakeData);
    socket.on("error", onHandshakeError);

    function readExact(n: number): Promise<Buffer> {
      if (pending.length >= n) {
        const out = pending.subarray(0, n);
        pending = pending.subarray(n);
        return Promise.resolve(out);
      }
      return new Promise((res, rej) => {
        waiter = { n, res, rej };
      });
    }

    /** Detach the handshake reader; leftover bytes go back for the pipe phase. */
    function endHandshakeReader(): void {
      socket.off("data", onHandshakeData);
      socket.off("error", onHandshakeError);
      if (pending.length > 0) {
        socket.unshift(pending);
        pending = Buffer.alloc(0);
      }
    }

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      socket.setTimeout(0);
      socket.destroy();
      reject(err);
    };
    /** Refusals (vs network errors) — counted separately in relay stats. */
    const refuse = (msg: string): Error => Object.assign(new Error(msg), { refused: true });

    socket.once("timeout", () => fail(new Error(`upstream ${up.label} connect timeout`)));
    socket.once("error", fail);
    socket.once("connect", () => {
      void handshake().then(
        () => {
          if (settled) return;
          settled = true;
          socket.setTimeout(0);
          socket.removeAllListeners("timeout");
          socket.removeAllListeners("error");
          endHandshakeReader();
          resolve(socket);
        },
        fail,
      );
    });

    async function handshake(): Promise<void> {
      // 1) Greeting: offer no-auth (0x00), and user/pass (0x02) only when we
      //    actually have credentials — never advertise auth we won't honor.
      const methods = up.authSocks ? [0x00, 0x02] : [0x00];
      socket.write(
        Buffer.from([0x05, methods.length, ...methods]),
      );
      const chosen = (await readExact(2))[1]!;
      if (chosen === 0xff) {
        throw refuse(`upstream ${up.label} rejected all SOCKS5 auth methods`);
      }
      // 2) RFC 1929 subnegotiation when the server picks user/pass.
      if (chosen === 0x02) {
        if (!up.authSocks) {
          throw refuse(`upstream ${up.label} demanded SOCKS5 auth but none is configured`);
        }
        const u = Buffer.from(up.authSocks.user, "utf8");
        const p = Buffer.from(up.authSocks.pass, "utf8");
        if (u.length > 255 || p.length > 255) {
          throw new Error("SOCKS5 credentials exceed 255 bytes (RFC 1929 limit)");
        }
        socket.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
        if ((await readExact(2))[1] !== 0x00) {
          throw refuse(`upstream ${up.label} rejected SOCKS5 credentials`);
        }
      }
      // 3) CONNECT request with the original target (remote resolution).
      const portBuf = Buffer.from([targetPort >> 8, targetPort & 0xff]);
      let addr: Buffer;
      let atyp: number;
      if (net.isIPv4(targetHost)) {
        atyp = 0x01;
        addr = Buffer.from(targetHost.split(".").map((o) => Number(o)));
      } else if (net.isIPv6(targetHost)) {
        atyp = 0x04;
        // Normalize via the URL parser (handles "::" compression) then pack.
        const groups = new URL(`http://[${targetHost}]`).hostname.replace(/^\[|\]$/g, "").split(":");
        const bytes = new Uint8Array(16);
        for (let i = 0; i < 8; i++) {
          const g = parseInt(groups[i]!, 16);
          bytes[i * 2] = g >> 8;
          bytes[i * 2 + 1] = g & 0xff;
        }
        addr = Buffer.from(bytes);
      } else {
        const h = Buffer.from(targetHost, "utf8");
        if (h.length > 255) {
          throw new Error(`target hostname exceeds 255 bytes: ${targetHost.slice(0, 40)}`);
        }
        atyp = 0x03;
        addr = Buffer.concat([Buffer.from([h.length]), h]);
      }
      socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, atyp]), addr, portBuf]));
      const reply = await readExact(4);
      if (reply[0] !== 0x05) {
        throw refuse(`upstream ${up.label} sent a malformed SOCKS5 reply`);
      }
      if (reply[1] !== 0x00) {
        const codes: Record<number, string> = {
          1: "general failure",
          2: "connection not allowed",
          3: "network unreachable",
          4: "host unreachable",
          5: "connection refused",
          6: "TTL expired",
          7: "command not supported",
          8: "address type not supported",
        };
        throw new Error(
          `upstream ${up.label} refused SOCKS5 connect to ${targetHost}:${targetPort} ` +
            `(${codes[reply[1]!] ?? `rep=${reply[1]}`})`,
        );
      }
      // 4) Consume the bound-address trailer so piped traffic starts clean.
      const atypOut = reply[3]!;
      let trailer = 0;
      if (atypOut === 0x01) trailer = 4;
      else if (atypOut === 0x03) trailer = (await readExact(1))[0]!;
      else if (atypOut === 0x04) trailer = 16;
      else {
        throw refuse(`upstream ${up.label} sent a malformed SOCKS5 bound address`);
      }
      if (trailer > 0) await readExact(trailer + 2); // + bound port
    }
  });
}

/**
 * Parse a CONNECT target ("host:port", bracketed IPv6 "[::1]:443" included).
 * Returns null when the target is malformed.
 */
export function parseConnectTarget(target: string): { host: string; port: number } | null {
  const m = /^\[?([^\]]+)\]?:(\d+)$/.exec(target.trim());
  if (!m || !m[1] || !m[2]) return null;
  const port = Number(m[2]);
  if (port < 1 || port > 65535) return null;
  return { host: m[1], port };
}

/**
 * A placeholder on a dead relay's port. After an API restart an adopted
 * engine still sends ALL its traffic to `--proxy-server=127.0.0.1:<port>`,
 * but the relay that listened there died with the old API process. The
 * engine fails closed while the port is empty — yet whatever binds that port
 * next receives the profile's traffic: any local process, or a NEW relay in
 * this API whose OS-assigned port happens to collide, which would route one
 * profile through another profile's proxy (an identity linkage).
 *
 * Holding the port ourselves closes that: every connection gets a 502 and is
 * dropped, so the engine keeps failing closed and nothing else can take the
 * port. Returns null when the port is already taken — the caller must treat
 * that as "the engine's traffic may be going to a stranger".
 */
export interface RelayPortHold {
  readonly port: number;
  /** Connections refused since the hold started (the engine tried to browse). */
  readonly refused: () => number;
  close(): Promise<void>;
}

export async function holdRelayPort(port: number): Promise<RelayPortHold | null> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  let refused = 0;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    refused++;
    sockets.add(client);
    client.once("close", () => sockets.delete(client));
    client.on("error", () => client.destroy());
    client.end(
      "HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n" +
        "X-QueuePilot: relay lost after API restart - restart this profile\r\n\r\n",
    );
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
  } catch {
    return null;
  }
  let closed: Promise<void> | null = null;
  return {
    port,
    refused: () => refused,
    close: () => {
      if (!closed) {
        closed = new Promise((resolve) => {
          server.close(() => resolve());
          for (const socket of sockets) socket.destroy();
        });
      }
      return closed;
    },
  };
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
    client.on("error", () => client.destroy());
    readHead(client)
      .then((head) => void handleClient(client, head))
      .catch(() => client.destroy());
  });

  function wireUpstream(client: net.Socket, upstream: net.Socket): void {
    // `on`, not `once`: a socket can error more than once, and an unhandled
    // 'error' on any socket crashes the process (EPIPE on piped writes is
    // routine when either side hangs up). destroy() is idempotent.
    upstream.on("error", () => {
      client.destroy();
      upstream.destroy();
    });
    // Engine gone = tunnel gone; never leave an upstream socket lingering.
    client.on("close", () => upstream.destroy());
  }

  async function handleClient(client: net.Socket, head: Buffer): Promise<void> {
    const firstLine = head.subarray(0, head.indexOf("\r\n")).toString("latin1");
    const method = firstLine.split(" ")[0] ?? "";

    if (method === "CONNECT") {
      const target = firstLine.split(" ")[1] ?? "";
      if (up.protocol === "socks5") {
        const t = parseConnectTarget(target);
        if (!t) {
          stats.rejected++;
          client.write("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
          client.destroy();
          return;
        }
        let upstream: net.Socket;
        try {
          upstream = await socks5Connect(up, t.host, t.port);
        } catch (err) {
          if ((err as { refused?: boolean }).refused) stats.rejected++;
          else stats.upstreamErrors++;
          // Fail closed: the client sees the failure, traffic NEVER detours.
          client.write("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
          client.destroy();
          return;
        }
        wireUpstream(client, upstream);
        stats.tunnels++;
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        client.pipe(upstream).pipe(client);
        return;
      }

      let upstream: net.Socket;
      try {
        upstream = await connectUpstream(up);
      } catch {
        stats.upstreamErrors++;
        client.write("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
        client.destroy();
        return;
      }
      wireUpstream(client, upstream);
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

    if (up.protocol === "socks5") {
      // Plain HTTP over a SOCKS5 upstream: dial the absolute-URL host through
      // the SOCKS5 handshake, rewrite the request line to origin-form. Auth
      // rides inside the handshake — no header injection here.
      const reqLine = /^(\S+)\s+(\S+)\s+HTTP\/1\.[01]$/.exec(firstLine);
      let url: URL;
      if (!reqLine || !(reqLine[2]?.startsWith("http://") || reqLine[2]?.startsWith("https://"))) {
        stats.rejected++;
        client.write("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
        client.destroy();
        return;
      }
      try {
        url = new URL(reqLine[2]);
      } catch {
        stats.rejected++;
        client.write("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
        client.destroy();
        return;
      }
      let upstream: net.Socket;
      try {
        upstream = await socks5Connect(up, url.hostname, Number(url.port || 80));
      } catch (err) {
        if ((err as { refused?: boolean }).refused) stats.rejected++;
        else stats.upstreamErrors++;
        client.write("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
        client.destroy();
        return;
      }
      wireUpstream(client, upstream);
      const headText = head.toString("latin1");
      const rewritten = headText
        .split("\r\n")
        .map((line, i) =>
          i === 0
            ? `${reqLine[1]} ${url.pathname}${url.search} HTTP/1.1`
            : /^connection:/i.test(line)
              ? null
              : line,
        )
        .filter((line): line is string => line !== null)
        .join("\r\n")
        .replace("\r\n\r\n", "\r\nConnection: close\r\n\r\n");
      upstream.write(rewritten, "latin1");
      stats.requests++;
      client.pipe(upstream).pipe(client);
      return;
    }

    // Plain HTTP over an http/https upstream (absolute-form). Inject auth,
    // force Connection: close so every request carries the credentials.
    let upstream: net.Socket;
    try {
      upstream = await connectUpstream(up);
    } catch {
      stats.upstreamErrors++;
      client.write("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
      client.destroy();
      return;
    }
    wireUpstream(client, upstream);
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
