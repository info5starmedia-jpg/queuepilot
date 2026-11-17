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
    // The relay tears its side down when the tunnel ends; without a listener
    // the resulting ECONNRESET on this fixture socket is an uncaught
    // exception that fails the whole vitest run with every test green.
    client.on("error", () => client.destroy());
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

/** Minimal SOCKS5 server (RFC 1928 + 1929) that enforces user/pass. */
interface Socks5Handle {
  server: net.Server;
  port: number;
  seenUser: (string | null)[];
  connectCount: () => number;
  lastTarget: () => { host: string; port: number } | null;
}

function startSocks5(opts: { user: string; pass: string }): Promise<Socks5Handle> {
  const seenUser: (string | null)[] = [];
  let connects = 0;
  let lastTarget: { host: string; port: number } | null = null;

  // Session reader: one persistent data listener + accumulating buffer.
  // (unshift-then-reattach hangs on modern Node; see the relay's reader.)
  function makeReader(sock: net.Socket) {
    let pending = Buffer.alloc(0);
    let waiter: { n: number; res: (b: Buffer) => void; rej: (e: Error) => void } | null = null;
    const onData = (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      if (waiter && pending.length >= waiter.n) {
        const w = waiter;
        waiter = null;
        w.res(pending.subarray(0, w.n));
        pending = pending.subarray(w.n);
      }
    };
    const onErr = (err: Error) => {
      if (waiter) {
        const w = waiter;
        waiter = null;
        w.rej(err);
      }
    };
    const onEnd = () => {
      if (waiter) {
        const w = waiter;
        waiter = null;
        w.rej(new Error("socks5 fixture: early end"));
      }
    };
    sock.on("data", onData);
    sock.on("error", onErr);
    sock.on("end", onEnd);
    return {
      read(n: number): Promise<Buffer> {
        if (pending.length >= n) {
          const out = pending.subarray(0, n);
          pending = pending.subarray(n);
          return Promise.resolve(out);
        }
        return new Promise((res, rej) => {
          waiter = { n, res, rej };
        });
      },
      end() {
        sock.off("data", onData);
        sock.off("error", onErr);
        sock.off("end", onEnd);
        if (pending.length > 0) {
          sock.unshift(pending);
          pending = Buffer.alloc(0);
        }
      },
    };
  }

  const server = net.createServer((sock) => {
    // Permanent listener: the reader's own handler is removed when the
    // handshake ends, leaving a window where a reset would be uncaught.
    sock.on("error", () => sock.destroy());
    void (async () => {
      const r = makeReader(sock);
      try {
        // Greeting.
        const greet = await r.read(2);
        const n = greet[1]!;
        const methods = await r.read(n);
        const wantsAuth = methods.includes(0x02);
        if (!wantsAuth) {
          sock.write(Buffer.from([0x05, 0x00])); // no-auth — fixture still fine
        } else {
          sock.write(Buffer.from([0x05, 0x02])); // choose user/pass
          const ver = (await r.read(1))[0]!;
          const ulen = (await r.read(1))[0]!;
          const user = (await r.read(ulen)).toString("utf8");
          const plen = (await r.read(1))[0]!;
          const pass = (await r.read(plen)).toString("utf8");
          seenUser.push(user);
          sock.write(Buffer.from([ver, user === opts.user && pass === opts.pass ? 0x00 : 0x01]));
          if (!(user === opts.user && pass === opts.pass)) {
            sock.end();
            return;
          }
        }
        // CONNECT request.
        const hdr = await r.read(4);
        const atyp = hdr[3]!;
        let host = "";
        if (atyp === 0x01) {
          host = Array.from(await r.read(4)).join(".");
        } else if (atyp === 0x03) {
          const len = (await r.read(1))[0]!;
          host = (await r.read(len)).toString("utf8");
        } else if (atyp === 0x04) {
          const raw = await r.read(16);
          const groups: string[] = [];
          for (let i = 0; i < 16; i += 2) {
            groups.push(raw.readUInt16BE(i).toString(16));
          }
          host = groups.join(":");
        } else {
          sock.end();
          return;
        }
        const portBuf = await r.read(2);
        const port = portBuf.readUInt16BE(0);
        lastTarget = { host, port };
        connects++;
        const onDialError = () => {
          sock.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0])); // refused
          sock.end();
        };
        const target = net.connect(port, host, () => {
          target.removeListener("error", onDialError);
          sock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          r.end(); // push back over-read tunnel bytes before piping
          sock.on("error", () => {
            sock.destroy();
            target.destroy();
          });
          target.on("error", () => {
            sock.destroy();
            target.destroy();
          });
          sock.pipe(target).pipe(sock);
        });
        target.on("error", onDialError);
      } catch {
        sock.destroy();
      }
    })();
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({
        server,
        port: (server.address() as { port: number }).port,
        seenUser,
        connectCount: () => connects,
        lastTarget: () => lastTarget,
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

  it("parses socks5 (and socks5h) with default port 1080 and decoded creds", () => {
    const up = parseUpstream("socks5://alice:s3cret@proxy.example");
    expect(up.protocol).toBe("socks5");
    expect(up.port).toBe(1080);
    expect(up.authSocks).toEqual({ user: "alice", pass: "s3cret" });
    expect(up.authBasic).toBeNull();
    expect(up.label).toBe("socks5://proxy.example:1080"); // redacted
    expect(parseUpstream("socks5h://proxy.example:1081").protocol).toBe("socks5");
    expect(parseUpstream("socks5://proxy.example:1081").port).toBe(1081);
    // No creds → no auth offered.
    expect(parseUpstream("socks5://proxy.example").authSocks).toBeNull();
  });

  it("refuses unknown schemes loudly instead of falling back to direct", () => {
    try {
      parseUpstream("ftp://127.0.0.1:21");
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

  it("tunnels CONNECT through a socks5 upstream with RFC 1929 credentials", async () => {
    const target = await startTarget();
    const socks = await startSocks5({ user: "alice", pass: "s3cret" });
    const relay = await startProxyRelay(
      `socks5://alice:s3cret@127.0.0.1:${socks.port}`,
    );
    try {
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
        socket.setTimeout(8000, () => reject(new Error("socks5 tunneled GET timed out")));
      });
      expect(full).toContain("TARGET-REACHED");
      expect(socks.seenUser).toEqual(["alice"]);
      expect(socks.connectCount()).toBe(1);
      expect(socks.lastTarget()).toEqual({ host: "127.0.0.1", port: target.port });
      expect(relay.stats.tunnels).toBe(1);
    } finally {
      await relay.close();
      socks.server.close();
      target.server.close();
    }
  });

  it("socks5 fail-closed: wrong credentials get 502, never a direct detour", async () => {
    const socks = await startSocks5({ user: "alice", pass: "s3cret" });
    const relay = await startProxyRelay(`socks5://alice:wrong@127.0.0.1:${socks.port}`);
    try {
      const resp = await converse(
        relay.port,
        "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n",
        (acc) => acc.includes("\r\n\r\n"),
      );
      expect(resp).toContain("502");
      expect(socks.connectCount()).toBe(0); // refused BEFORE any target dial
      expect(relay.stats.rejected).toBe(1);
      expect(relay.stats.tunnels).toBe(0);
    } finally {
      await relay.close();
      socks.server.close();
    }
  });

  it("forwards plain HTTP through a socks5 upstream (origin-form rewrite)", async () => {
    const target = await startTarget();
    const socks = await startSocks5({ user: "alice", pass: "s3cret" });
    const relay = await startProxyRelay(
      `socks5://alice:s3cret@127.0.0.1:${socks.port}`,
    );
    try {
      const resp = await converse(
        relay.port,
        `GET http://127.0.0.1:${target.port}/ HTTP/1.1\r\nHost: 127.0.0.1:${target.port}\r\n\r\n`,
        (acc) => acc.includes("TARGET-REACHED"),
      );
      expect(resp).toContain("TARGET-REACHED");
      expect(socks.seenUser).toEqual(["alice"]);
      expect(relay.stats.requests).toBe(1);
    } finally {
      await relay.close();
      socks.server.close();
      target.server.close();
    }
  });

  it("socks5 hostname targets are remote-resolved at the upstream", async () => {
    // "localhost" must arrive as a domain (ATYP 0x03), not be pre-resolved —
    // the upstream does DNS, that's the socks5h contract.
    const target = await startTarget();
    const socks = await startSocks5({ user: "a", pass: "b" });
    const relay = await startProxyRelay(`socks5://a:b@127.0.0.1:${socks.port}`);
    try {
      const resp = await converse(
        relay.port,
        `CONNECT localhost:${target.port} HTTP/1.1\r\nHost: localhost:${target.port}\r\n\r\n`,
        (acc) => acc.includes("\r\n\r\n"),
      );
      expect(resp).toContain("200");
      expect(socks.lastTarget()).toEqual({ host: "localhost", port: target.port });
    } finally {
      await relay.close();
      socks.server.close();
      target.server.close();
    }
  });
});
