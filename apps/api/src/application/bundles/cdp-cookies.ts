import { CdpConnection } from "../runtime/cdp/cdp-connection.js";
import { attachPageSession } from "../runtime/cdp/cdp-page-session.js";
import type { BundleCookie } from "./session-bundle.js";

/**
 * CDP cookie transport: export/import over the browser-level socket.
 * `Network.*` are page-domain methods, so every call goes out on a session
 * attached to a page target (attachPageSession) — the browser-level socket
 * itself rejects them. `Network.getAllCookies` sees every browser context
 * (every session partition), which is exactly what a roaming bundle must
 * carry.
 */

interface CdpCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  secure: boolean;
  httpOnly: boolean;
}

function toBundleCookie(c: CdpCookie): BundleCookie {
  return {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    expires: c.expires,
    secure: c.secure,
    httpOnly: c.httpOnly,
  };
}

export async function exportCookiesViaCdp(wsEndpoint: string): Promise<BundleCookie[]> {
  const conn = await CdpConnection.connect(wsEndpoint, 10_000);
  try {
    const session = await attachPageSession(conn);
    try {
      const { cookies } = await conn.call<{ cookies: CdpCookie[] }>(
        "Network.getAllCookies",
        {},
        15_000,
        session.sessionId,
      );
      return cookies.map(toBundleCookie);
    } finally {
      await session.release();
    }
  } finally {
    conn.close();
  }
}

export async function importCookiesViaCdp(
  wsEndpoint: string,
  cookies: BundleCookie[],
): Promise<void> {
  const conn = await CdpConnection.connect(wsEndpoint, 10_000);
  try {
    const session = await attachPageSession(conn);
    try {
      await conn.call(
        "Network.setCookies",
        {
          cookies: cookies.map((c) => ({
            name: c.name,
            value: c.value,
            domain: c.domain,
            path: c.path,
            expires: c.expires,
            secure: c.secure,
            httpOnly: c.httpOnly,
          })),
        },
        15_000,
        session.sessionId,
      );
    } finally {
      await session.release();
    }
  } finally {
    conn.close();
  }
}
