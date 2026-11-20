import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { makeTestContext } from "./helpers.js";

/**
 * Proxy validation (v0.15.1, audit G3). The probe must make a REAL request
 * through the proxy and report the exit IP + geo — a TCP connect alone
 * (the old behavior) can't tell a working tunnel from a dead port that
 * accepts connections.
 */

const GEO_BODY = JSON.stringify({
  status: "success",
  query: "203.0.113.7",
  country: "United States",
  countryCode: "US",
  regionName: "Florida",
  city: "Miami",
  timezone: "America/New_York",
});

function httpResponse(status: string, body: string): string {
  return `HTTP/1.1 ${status}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`;
}

let servers: net.Server[] = [];

async function startFakeProxy(handler: (socket: net.Socket, firstChunk: Buffer) => void): Promise<number> {
  const server = net.createServer((socket) => {
    socket.once("data", (d) => handler(socket, d));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as net.AddressInfo).port;
}

afterEach(async () => {
  for (const s of servers) s.close();
  servers = [];
});

describe("proxy validation probe", () => {
  it("http proxy: reports exit IP + geo from a real request through it", async () => {
    let sawAbsoluteUri = false;
    const port = await startFakeProxy((socket, first) => {
      sawAbsoluteUri = first.toString().startsWith("GET http://");
      socket.end(httpResponse("200 OK", GEO_BODY));
    });
    const { proxies } = makeTestContext();
    const p = proxies.create({ name: "fake-http", type: "http", host: "127.0.0.1", port });

    const r = await proxies.test(p.id, 2000, "http://probe.example/json");
    expect(r.ok).toBe(true);
    expect(r.error).toBeNull();
    expect(r.latencyMs).not.toBeNull();
    expect(r.exitIp).toBe("203.0.113.7");
    expect(r.geo).toEqual({
      country: "United States",
      countryCode: "US",
      region: "Florida",
      city: "Miami",
      timezone: "America/New_York",
    });
    expect(sawAbsoluteUri).toBe(true);
  });

  it("http proxy: 407 becomes a clear auth-failure, not a generic error", async () => {
    const port = await startFakeProxy((socket) => {
      socket.end(httpResponse("407 Proxy Authentication Required", "{}"));
    });
    const { proxies } = makeTestContext();
    const p = proxies.create({ name: "auth-fail", type: "http", host: "127.0.0.1", port });

    const r = await proxies.test(p.id, 2000, "http://probe.example/json");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/authentication failed/);
    expect(r.exitIp).toBeNull();
  });

  it("http proxy: sends Proxy-Authorization when credentials are set", async () => {
    let authHeader: string | null = null;
    const port = await startFakeProxy((socket, first) => {
      const text = first.toString();
      authHeader = /^Proxy-Authorization: (.*)$/m.exec(text)?.[1] ?? null;
      socket.end(httpResponse("200 OK", GEO_BODY));
    });
    const { proxies } = makeTestContext();
    const p = proxies.create({
      name: "creds",
      type: "http",
      host: "127.0.0.1",
      port,
      username: "alice",
      password: "s3cret",
    });

    const r = await proxies.test(p.id, 2000, "http://probe.example/json");
    expect(r.ok).toBe(true);
    expect(authHeader).toBe(`Basic ${Buffer.from("alice:s3cret").toString("base64")}`);
  });

  it("socks5 proxy: CONNECT handshake then origin-form GET", async () => {
    let requestLine: string | null = null;
    const port = await startFakeProxy((socket, first) => {
      // Stage 1: greeting [5, n, methods...] -> accept no-auth [5, 0].
      expect(first[0]).toBe(0x05);
      socket.write(Buffer.from([0x05, 0x00]));
      socket.once("data", (connectReq) => {
        // Stage 2: CONNECT [5,1,0,3,len,host,port] -> success [5,0,0,1,0,0,0,0,0,0].
        expect(connectReq[0]).toBe(0x05);
        expect(connectReq[1]).toBe(0x01);
        socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        socket.once("data", (get) => {
          requestLine = get.toString().split("\r\n")[0] ?? null;
          socket.end(httpResponse("200 OK", GEO_BODY));
        });
      });
    });
    const { proxies } = makeTestContext();
    const p = proxies.create({ name: "fake-socks5", type: "socks5", host: "127.0.0.1", port });

    const r = await proxies.test(p.id, 2000, "http://probe.example/json");
    expect(r.ok).toBe(true);
    expect(r.exitIp).toBe("203.0.113.7");
    // Through a socks5 tunnel the request is origin-form, not absolute-URI.
    expect(requestLine).toBe("GET /json HTTP/1.1");
  });

  it("unreachable proxy: fast clean failure, no throw", async () => {
    const { proxies } = makeTestContext();
    const p = proxies.create({ name: "dead", type: "http", host: "127.0.0.1", port: 1 });
    const r = await proxies.test(p.id, 500);
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
    expect(r.exitIp).toBeNull();
    expect(r.geo).toBeNull();
  });
});
