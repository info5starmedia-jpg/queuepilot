import net from "node:net";
import tls from "node:tls";

/**
 * Real proxy validation (audit G3, v0.15.1).
 *
 * The old test() was a bare TCP connect: it proved the port answers, not that
 * the tunnel carries traffic or that credentials work. This probe makes a
 * REAL request through the proxy to a geo-IP echo service and reports the
 * exit IP + geo the target site would see — the numbers that actually matter
 * for per-profile proxy rotation.
 *
 * Supported: http / https (absolute-URI GET through the proxy) and socks5
 * (CONNECT handshake, then origin-form GET). The probe target is plain HTTP
 * on purpose: it keeps every proxy type on one code path and avoids
 * TLS-over-CONNECT entirely.
 */

export interface ProxyGeo {
  country: string | null;
  region: string | null;
  city: string | null;
  timezone: string | null;
}

export interface ProbeResult {
  ok: boolean;
  error: string | null;
  exitIp: string | null;
  geo: ProxyGeo | null;
}

/** Free, keyless geo-IP echo. Override in tests with a local fake. */
export const DEFAULT_PROBE_URL = "http://ip-api.com/json";

interface ProxyEndpoint {
  type: "http" | "https" | "socks5";
  host: string;
  port: number;
  username: string | null;
  password: string | null;
}

class ProbeError extends Error {}

function withTimeout(socket: net.Socket, timeoutMs: number, onTimeout: () => void): void {
  socket.setTimeout(timeoutMs, onTimeout);
}

/** Read a full HTTP/1.1 response (Connection: close) from a connected socket. */
function readHttpResponse(socket: net.Socket, timeoutMs: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    withTimeout(socket, timeoutMs, () => fail(new ProbeError("response timeout")));
    socket.on("data", (d) => chunks.push(d));
    socket.on("end", () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString("utf8");
      const sep = raw.indexOf("\r\n\r\n");
      if (sep === -1) return reject(new ProbeError("malformed proxy response"));
      const head = raw.slice(0, sep);
      const status = Number(/^HTTP\/\d\.\d (\d{3})/.exec(head)?.[1]);
      if (!status) return reject(new ProbeError("malformed proxy response"));
      resolve({ status, body: raw.slice(sep + 4) });
    });
    socket.on("error", fail);
  });
}

function writeHttpGet(
  socket: net.Socket,
  target: URL,
  opts: { absoluteUri: boolean; auth: ProxyEndpoint },
): void {
  const path = opts.absoluteUri ? target.href : `${target.pathname}${target.search}`;
  const lines = [
    `GET ${path} HTTP/1.1`,
    `Host: ${target.host}`,
    "User-Agent: QueuePilot-ProxyProbe/0.15",
    "Accept: application/json",
    "Connection: close",
  ];
  if (opts.auth.username) {
    const token = Buffer.from(
      `${opts.auth.username}:${opts.auth.password ?? ""}`,
    ).toString("base64");
    lines.push(`Proxy-Authorization: Basic ${token}`);
  }
  socket.write(lines.join("\r\n") + "\r\n\r\n");
}

/** SOCKS5: no-auth or username/password greeting, then CONNECT to host:port. */
function socks5Connect(socket: net.Socket, host: string, port: number, auth: ProxyEndpoint, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    withTimeout(socket, timeoutMs, () => fail(new ProbeError("socks5 handshake timeout")));

    const useAuth = !!auth.username;
    const methods = useAuth ? [0x02] : [0x00];
    const greeting = Buffer.from([0x05, methods.length, ...methods]);
    let stage: "greet" | "auth" | "connect" = "greet";

    const onData = (d: Buffer) => {
      try {
        if (stage === "greet") {
          if (d.length < 2 || d[0] !== 0x05) throw new ProbeError("bad socks5 greeting reply");
          if (d[1] === 0xff) throw new ProbeError("socks5 proxy rejected all auth methods");
          if (d[1] === 0x02) {
            if (!useAuth) throw new ProbeError("socks5 proxy demands credentials");
            stage = "auth";
            const u = Buffer.from(auth.username!, "utf8");
            const p = Buffer.from(auth.password ?? "", "utf8");
            socket.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
            return;
          }
          stage = "connect";
          sendConnect();
          return;
        }
        if (stage === "auth") {
          if (d.length < 2 || d[1] !== 0x00) throw new ProbeError("socks5 authentication failed");
          stage = "connect";
          sendConnect();
          return;
        }
        // stage === "connect"
        if (d.length < 2 || d[0] !== 0x05) throw new ProbeError("bad socks5 connect reply");
        if (d[1] !== 0x00) throw new ProbeError(`socks5 connect failed (code ${d[1]})`);
        settled = true;
        socket.off("data", onData);
        resolve();
      } catch (err) {
        fail(err as Error);
      }
    };

    const sendConnect = () => {
      const hb = Buffer.from(host, "utf8");
      const req = Buffer.concat([
        Buffer.from([0x05, 0x01, 0x00, 0x03, hb.length]),
        hb,
        Buffer.from([port >> 8, port & 0xff]),
      ]);
      socket.write(req);
    };

    socket.on("data", onData);
    socket.on("error", fail);
    socket.write(greeting);
  });
}

function parseGeo(body: string): { exitIp: string | null; geo: ProxyGeo | null } {
  try {
    const j = JSON.parse(body) as Record<string, unknown>;
    const exitIp = typeof j.query === "string" ? j.query : null;
    const pick = (k: string) => (typeof j[k] === "string" ? (j[k] as string) : null);
    const geo: ProxyGeo = {
      country: pick("country"),
      region: pick("regionName"),
      city: pick("city"),
      timezone: pick("timezone"),
    };
    return { exitIp, geo };
  } catch {
    return { exitIp: null, geo: null };
  }
}

/**
 * Run the probe. Never throws for proxy-side failures — those come back as
 * { ok: false, error }; only programmer errors (bad URL) throw.
 */
export async function probeProxy(endpoint: ProxyEndpoint, probeUrl: string, timeoutMs: number): Promise<ProbeResult> {
  const target = new URL(probeUrl);
  const targetPort = Number(target.port || 80);

  const socket = net.connect({ host: endpoint.host, port: endpoint.port });
  const dead: Promise<never> = new Promise((_, reject) => {
    socket.once("error", (err) => reject(new ProbeError(err.message)));
  });
  // Keep a handled branch so a late socket error (e.g. after destroy) can
  // never surface as an unhandled rejection; derived .catch chains still fire.
  dead.catch(() => {});
  const connected: Promise<net.Socket> = new Promise((resolve, reject) => {
    withTimeout(socket, timeoutMs, () => reject(new ProbeError("connect timeout")));
    socket.once("connect", () => resolve(socket));
    socket.once("error", (err) => reject(new ProbeError(err.message)));
  });

  try {
    await connected;

    let wire: net.Socket = socket;
    if (endpoint.type === "https") {
      // TLS first, then talk HTTP through the encrypted proxy channel.
      wire = tls.connect({ socket, servername: endpoint.host, host: endpoint.host });
      const tlsTimer = setTimeout(() => socket.destroy(new ProbeError("TLS handshake timeout")), timeoutMs);
      try {
        await new Promise<void>((resolve, reject) => {
          wire.once("secureConnect", () => resolve());
          wire.once("error", (err) => reject(new ProbeError(err.message)));
        });
      } finally {
        clearTimeout(tlsTimer);
      }
    } else if (endpoint.type === "socks5") {
      await socks5Connect(socket, target.hostname, targetPort, endpoint, timeoutMs);
    }

    // http/https: absolute-URI GET (the proxy forwards it). socks5: the
    // handshake gave a direct tunnel, so origin-form is correct.
    writeHttpGet(wire, target, { absoluteUri: endpoint.type !== "socks5", auth: endpoint });
    const res = await Promise.race([
      readHttpResponse(wire, timeoutMs),
      dead.catch(() => {
        throw new ProbeError("connection dropped by proxy");
      }),
    ]);

    if (res.status === 407) {
      return { ok: false, error: "proxy authentication failed (407)", exitIp: null, geo: null };
    }
    if (res.status !== 200) {
      return { ok: false, error: `probe endpoint answered ${res.status}`, exitIp: null, geo: null };
    }
    const { exitIp, geo } = parseGeo(res.body);
    return { ok: true, error: null, exitIp, geo };
  } catch (err) {
    return { ok: false, error: (err as Error).message, exitIp: null, geo: null };
  } finally {
    socket.destroy();
  }
}
