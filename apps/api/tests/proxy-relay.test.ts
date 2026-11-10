import { describe, expect, it } from "vitest";
import http from "node:http";
import net from "node:net";
import { ErrorCodes } from "@queuepilot/contracts";
import { parseUpstream, startProxyRelay } from "../src/application/runtime/proxy-relay.js";

/**
 * The relay is the fix for the P0 proxy leak, so its tests emulate the REAL
 * shape of the problem: a target origin, an upstream forward proxy that
 * demands Proxy-Authorization, and raw-socket clients. Fail-closed behavior
 * (upstream refusal reaches the client verbatim, never a direct detour) is
 * asserted explicitly.
 */

const AUTH = `Basic ${Buffer.from("alice:s3cret").toString("base64")}`;

function startTarget(): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain", connection: "close" });
    res.end("TARGET-REACHED");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, port: (server.address() as { port: number }).port }),
    );
  });
}

interface UpstreamHandle {
  server: http.Server;
  port: number;
  seenAuth: (string | null)[];
  connectCount: () => number;
}

/** A minimal forward proxy that enforces Proxy-Authorization on every hop. */
function startUpstream(): Promise<UpstreamHandle> {
  const seenAuth: (string | null)[] = [];
  let connects = 0;
  const server = http.createServer((req, res) => {
    seenAuth.push(req.headers["proxy-authorization"] ?? null);
    if (req.headers["proxy-authorization"] !== AUTH) {
      res.writeHead(407, { "proxy-authenticate": "Basic realm=upstream" });
      res.end("auth required");
      return;
    }
    // Absolute-form forward proxying.
    const url = new URL(req.url ?? "/");
    const fwd = http.request(
      { host: url.hostname, port: url.port, path: url.pathname, method: req.method },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    fwd.on("error", () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(fwd);
  });
  server.on("connect", (req, client, head) => {
    connects++;
    seenAuth.push(req.headers["proxy-authorization"] ?? null);
    if (req.headers["proxy-authorization"] !== AUTH) {
      client.write("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
      client.destroy();
      return;
    }
    const [host, port] = (req.url ?? "").split(":");
    const target = net.connect(Number(port), host, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) target.write(head);
      client.pipe(target).pipe(client);
    });
    target.on("error", () => client.destroy());
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({
        server,
        port: (server.address() as { port: number }).port,
        seenAuth,
        connectCount: () => connects,
      }),
    );
  });
}

/** Raw-socket helper: send bytes, collect until close or predicate matches. */
function converse(
  port: number,
  send: string,
  done: (acc: string) => boolean,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => socket.write(send));
    let acc = "";
    socket.on("data", (d) => {
      acc += d.toString("latin1");
      if (done(acc)) {
        socket.destroy();
        resolve(acc);
      }
    });
    socket.on("close", () => resolve(acc));
    socket.on("error", reject);
    socket.setTimeout(8000, () => {
      socket.destroy();
      reject(new Error(`converse timed out; got: ${acc.slice(0, 200)}`));
    });
  });
}

describe("parseUpstream", () => {
  it("parses credentials and default ports", () => {
    const up = parseUpstream("http://alice:s3cret@proxy.example:8080");
    expect(up.authBasic).toBe(Buffer.from("alice:s3cret").toString("base64"));
    expect(up.host).toBe("proxy.example");
    expect(up.port).toBe(8080);
    expect(up.label).toBe("http://proxy.example:8080"); // redacted, no creds
    expect(parseUpstream("http://proxy.example").port).toBe(80);
    expect(parseUpstream("https://proxy.example").port).toBe(443);
  });

  it("refuses socks5 loudly instead of falling back to direct", () => {
    try {
      parseUpstream("socks5://127.0.0.1:1080");
      expect.unreachable();
    } catch (err) {
      expect((err as { code: string }).code).toBe(ErrorCodes.PROXY_UNSUPPORTED);
    }
  });

  it("refuses unparseable URLs", () => {
    try {
      parseUpstream("not a url");
      expect.unreachable();
    } catch (err) {
      expect((err as { code: string }).code).toBe(ErrorCodes.PROXY_UNSUPPORTED);
    }
  });
});

describe("proxy relay", () => {
  it("tunnels CONNECT with injected auth; upstream sees the credential", async () => {
    const target = await startTarget();
    const upstream = await startUpstream();
    const relay = await startProxyRelay(
      `http://alice:s3cret@127.0.0.1:${upstream.port}`,
    );
    try {
      // 1) CONNECT handshake through the relay.
      const handshake = await converse(
        relay.port,
        `CONNECT 127.0.0.1:${target.port} HTTP/1.1\r\nHost: 127.0.0.1:${target.port}\r\n\r\n`,
        (acc) => acc.includes("\r\n\r\n"),
      );
      expect(handshake).toContain("200");

      // 2) Full exchange on one socket: CONNECT then a tunneled GET.
      const full = await new Promise<string>((resolve, reject) => {
        const socket = net.connect(relay.port, "127.0.0.1", () =>
          socket.write(
            `CONNECT 127.0.0.1:${target.port} HTTP/1.1\r\nHost: 127.0.0.1:${target.port}\r\n\r\n`,
          ),
        );
        let acc = "";
        let established = false;
        socket.on("data", (d) => {
          acc += d.toString("latin1");
          if (!established && acc.includes("200 Connection Established")) {
            established = true;
            acc = "";
            socket.write(
              "GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
            );
          } else if (established && acc.includes("TARGET-REACHED")) {
            socket.destroy();
            resolve(acc);
          }
        });
        socket.on("error", reject);
        socket.setTimeout(8000, () => reject(new Error("tunneled GET timed out")));
      });
      expect(full).toContain("TARGET-REACHED");
      expect(upstream.seenAuth.every((a) => a === AUTH)).toBe(true);
      expect(upstream.connectCount()).toBeGreaterThan(0);
      expect(relay.stats.tunnels).toBeGreaterThan(0);
    } finally {
      await relay.close();
      upstream.server.close();
      target.server.close();
    }
  });

  it("fails closed: upstream 407 reaches the client, no direct detour", async () => {
    const upstream = await startUpstream();
    // Proxy URL WITHOUT credentials — upstream will refuse.
    const relay = await startProxyRelay(`http://127.0.0.1:${upstream.port}`);
    try {
      const resp = await converse(
        relay.port,
        "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n",
        (acc) => acc.includes("\r\n\r\n"),
      );
      expect(resp).toContain("407");
      expect(relay.stats.rejected).toBe(1);
    } finally {
      await relay.close();
      upstream.server.close();
    }
  });

  it("forwards plain HTTP with auth injected and Connection: close", async () => {
    const target = await startTarget();
    const upstream = await startUpstream();
    const relay = await startProxyRelay(
      `http://alice:s3cret@127.0.0.1:${upstream.port}`,
    );
    try {
      const resp = await converse(
        relay.port,
        `GET http://127.0.0.1:${target.port}/ HTTP/1.1\r\nHost: 127.0.0.1:${target.port}\r\n\r\n`,
        (acc) => acc.includes("TARGET-REACHED"),
      );
      expect(resp).toContain("TARGET-REACHED");
      expect(upstream.seenAuth).toContain(AUTH);
      expect(relay.stats.requests).toBe(1);
    } finally {
      await relay.close();
      upstream.server.close();
      target.server.close();
    }
  });

  it("answers 502 when the upstream is unreachable", async () => {
    // Port 1 is never listening; the relay must say so, not hang.
    const relay = await startProxyRelay("http://alice:x@127.0.0.1:1");
    try {
      const resp = await converse(
        relay.port,
        "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n",
        (acc) => acc.includes("\r\n\r\n"),
      );
      expect(resp).toContain("502");
      expect(relay.stats.upstreamErrors).toBe(1);
    } finally {
      await relay.close();
    }
  });

  it("close() is idempotent", async () => {
    const upstream = await startUpstream();
    const relay = await startProxyRelay(`http://127.0.0.1:${upstream.port}`);
    await relay.close();
    await relay.close();
    upstream.server.close();
  });
});
