import net from "node:net";
import tls from "node:tls";

/**
 * Fresh exit-IP check through the auth-injecting loopback relay (Fury 0071
 * agent contract: "the address from a fresh exit check on every proxied
 * launch, since a stale one from a rotating proxy would contradict the
 * address sites see").
 *
 * The check goes through the SAME relay the engine will use, so the address
 * we learn is by construction the one the profile's traffic exits from.
 * Failure is soft (null): the engine then gathers no candidates, which is
 * the safe direction — a wrong address is a contradiction, no address is
 * just "WebRTC gathered nothing", the 0.5.1 behavior.
 */

export interface EgressCheckOptions {
  /** IP echo endpoint. Plain HTTPS GET, body is the address as text. */
  host?: string;
  timeoutMs?: number;
}

const DEFAULT_ECHO_HOST = "api.ipify.org";

export async function egressIpViaRelay(
  relayPort: number,
  opts: EgressCheckOptions = {},
): Promise<string | null> {
  const host = opts.host ?? DEFAULT_ECHO_HOST;
  const timeoutMs = opts.timeoutMs ?? 5000;
  return new Promise((resolve) => {
    let settled = false;
    const done = (ip: string | null) => {
      if (!settled) {
        settled = true;
        resolve(ip);
      }
    };

    const socket = net.connect({ host: "127.0.0.1", port: relayPort });
    const fail = () => {
      socket.destroy();
      done(null);
    };
    socket.setTimeout(timeoutMs);
    socket.once("error", fail);
    socket.once("timeout", fail);

    socket.once("connect", () => {
      socket.write(
        `CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`,
      );
    });

    let handshake = Buffer.alloc(0);
    const onHandshakeData = (chunk: Buffer) => {
      handshake = Buffer.concat([handshake, chunk]);
      const headerEnd = handshake.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      socket.off("data", onHandshakeData);
      const statusLine = handshake.subarray(0, headerEnd).toString("latin1");
      if (!/^HTTP\/1\.[01] 200\b/.test(statusLine)) return fail();

      const tlsSocket = tls.connect(
        { socket, servername: host },
        () => {
          tlsSocket.write(
            `GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`,
          );
        },
      );
      tlsSocket.setTimeout(timeoutMs);
      tlsSocket.once("error", () => {
        tlsSocket.destroy();
        done(null);
      });
      tlsSocket.once("timeout", () => {
        tlsSocket.destroy();
        done(null);
      });
      let body = Buffer.alloc(0);
      let headersDone = false;
      tlsSocket.on("data", (chunk: Buffer) => {
        body = Buffer.concat([body, chunk]);
        if (!headersDone) {
          const idx = body.indexOf("\r\n\r\n");
          if (idx === -1) return;
          headersDone = true;
          body = body.subarray(idx + 4);
        }
        const text = body.toString("utf8");
        // Chunked or content-length: take the first dotted-quad in the body.
        const m = /(\d{1,3}(?:\.\d{1,3}){3})/.exec(text);
        if (m) {
          const ip = m[1]!;
          if (ip.split(".").every((o) => Number(o) <= 255)) {
            tlsSocket.destroy();
            done(ip);
          }
        }
      });
      tlsSocket.once("close", () => done(null));
    };
    socket.on("data", onHandshakeData);
  });
}
