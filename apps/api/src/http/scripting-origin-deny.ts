import { isIPv4 } from "node:net";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

/**
 * Browser-origin wall for the whole API (audit 2026-11-20, P0 SEC-2).
 *
 * Earlier versions protected only a hand-maintained list of "scripting"
 * routes; every route NOT on the list (cookie export, TOTP, profile
 * start/stop, the AdsPower launch, the whole profile list) was reachable by
 * any web page — including a hostile page open inside a profile browser,
 * and DNS-rebinding pages that make evil.com resolve to 127.0.0.1. The wall
 * is now DENY BY DEFAULT: every request passes the browser fingerprints
 * check except a tiny exempt set (see EXEMPT below).
 *
 * Browsers tell us where a fetch came from:
 *
 * - `Sec-Fetch-Site: cross-site` — the request was issued by a page whose
 *   origin differs from the API's; any profile browser visiting an outside
 *   site is exactly this.
 * - `Origin` — for same-site requests the header still names the page
 *   origin; if it does not match the request's own Host, the request is
 *   cross-origin and we refuse.
 * - `Host` — a rebinding page sends `Host: evil.com`; real clients reach the
 *   loopback API by IP literal or localhost.
 *
 * Non-browser clients (curl, httpx, Node CLIs, the desktop tray) send none
 * of the browser fingerprints and pass. The dashboard is same-origin (served
 * by this API), so its Origin equals Host and it passes.
 *
 * Additionally, browser-originated mutating requests that carry a body must
 * declare `application/json` or `multipart/form-data`: a same-origin page
 * posting a "simple request" form body is stuck with `text/plain`, so this
 * blocks the cross-site write trick's fallback. The check only applies when
 * Origin or Sec-Fetch-Site is present — a cross-site request was already
 * refused above, and local clients (curl, raw-byte proxy/plugin imports)
 * send neither header and must not be 415'd.
 */

/** Requests that must stay reachable for boot, monitoring and OAuth. */
const EXEMPT_PATHS = new Set(["/health", "/metrics", "/google/auth/callback"]);

function isDashboardAsset(url: string): boolean {
  const path = url.split("?")[0] ?? url;
  // The session-token endpoint lives under /dashboard/ for the bearer-hook
  // exemption, but it is SECRET — a DNS-rebinding page must not read it, so
  // the origin wall does not treat it as a static asset.
  if (path === "/dashboard/session-token") return false;
  return path === "/" || /^\/dashboard\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(path);
}

/**
 * Normalize a request path the way the router sees it (security audits
 * 2026-11-19/20): percent-decode, fold repeated slashes, drop ";params".
 * An undecodable path is treated as sensitive (all checks then apply).
 */
function normalizePath(url: string): string | null {
  let path = url.split("?")[0] ?? url;
  try {
    path = decodeURIComponent(path);
  } catch {
    return null;
  }
  return path.split(";")[0]!.replace(/\/{2,}/g, "/");
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "[::1]" ||
    hostname === "::1" ||
    // Exact check: "127.evil.com" must not pass (audit M1).
    (isIPv4(hostname) && hostname.startsWith("127."))
  );
}

/** Body-bearing mutating requests must declare a JSON or multipart body. */
function hasBody(req: FastifyRequest): boolean {
  const len = req.headers["content-length"];
  if (len !== undefined) return len !== "0";
  return req.headers["transfer-encoding"] !== undefined;
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function denyBrowserScriptingRequest(
  req: FastifyRequest,
  reply: FastifyReply,
): void {
  const path = normalizePath(req.url);

  // The exempt set: boot health, local monitoring, the OAuth redirect
  // target (a top-level navigation after a cross-site Google redirect
  // carries Sec-Fetch-Site: cross-site — that is expected), and static
  // dashboard files (no data; the page must render to reach its sign-in).
  if (path !== null && (EXEMPT_PATHS.has(path) || (req.method === "GET" && isDashboardAsset(req.url)))) {
    return;
  }

  // DNS rebinding (audit M1): a page on evil.com that re-resolves to 127.0.0.1
  // sends Host: evil.com. Real clients use an IP literal or localhost.
  const hostName = (req.headers.host ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  if (hostName && !isIPv4(hostName) && !hostName.includes(":") && hostName !== "localhost") {
    void reply.code(403).send({ error: { code: "FORBIDDEN", message: "unexpected Host header" } });
    return;
  }

  const secFetchSite = req.headers["sec-fetch-site"];
  if (secFetchSite === "cross-site") {
    void reply.code(403).send({
      error: {
        code: "FORBIDDEN",
        message: "cross-site requests are refused",
      },
    });
    return;
  }

  const origin = req.headers.origin;
  if (origin) {
    let refused = true;
    try {
      const parsed = new URL(origin);
      // Same-origin dashboard traffic: Origin host === request Host. Also
      // accept loopback origins unconditionally — a local page on loopback
      // cannot be a remote attacker, and operators reach the dashboard via
      // http://localhost:port as often as via 127.0.0.1.
      refused = !(parsed.host === req.headers.host || isLoopbackHost(parsed.hostname));
    } catch {
      /* unparsable Origin: refuse */
    }
    if (refused) {
      void reply.code(403).send({
        error: {
          code: "FORBIDDEN",
          message: "cross-origin requests are refused",
        },
      });
      return;
    }
  }

  // Content-type gate: only police requests a BROWSER could have made.
  // Cross-site requests were already refused above (they always carry
  // Origin / Sec-Fetch-Site), so this block exists for one case: a
  // same-origin page posting a "simple request" (text/plain form body).
  // Local clients (curl, the tray app, proxy .txt imports, plugin uploads)
  // send neither header and keep their raw-byte routes; 415ing them would
  // break legitimate non-browser callers without adding any security.
  if (MUTATING.has(req.method) && hasBody(req)) {
    const fromBrowser =
      req.headers.origin !== undefined || req.headers["sec-fetch-site"] !== undefined;
    if (fromBrowser) {
      const ct = String(req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
      if (ct !== "application/json" && ct !== "multipart/form-data") {
        void reply.code(415).send({
          error: {
            code: "UNSUPPORTED_MEDIA_TYPE",
            message: "browser-originated mutating requests require application/json or multipart/form-data",
          },
        });
      }
    }
  }
}

/** Register the deny hook on an app (kept as a function for testability). */
export function registerScriptingOriginDeny(app: FastifyInstance): void {
  app.addHook("onRequest", async (req, reply) => denyBrowserScriptingRequest(req, reply));
}
