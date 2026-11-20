import { isIPv4 } from "node:net";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

/**
 * Audit GPT-5.4 finding 1 (v0.16): scripting endpoints execute operator
 * code and touch secrets, so a web page loaded inside ANY profile browser
 * must never be able to reach them — even when the scripting opt-in is on
 * and even before the bearer-token hook runs. Browsers tell us where a
 * fetch came from:
 *
 * - `Sec-Fetch-Site: cross-site` — the request was issued by a page whose
 *   origin differs from the API's; any profile browser visiting an outside
 *   site is exactly this.
 * - `Origin` — for same-site requests the header still names the page
 *   origin; if it does not match the request's own Host, the request is
 *   cross-origin and we refuse.
 *
 * Non-browser clients (curl, httpx, Node CLIs, the desktop tray) send
 * neither header and are unaffected. The dashboard is same-origin (served
 * by this API), so its Origin equals Host and it passes. Read-only GETs
 * from a top-level navigation carry no Origin and remain reachable — the
 * dangerous verbs all carry one of the fingerprints above.
 */

const SCRIPTING_PREFIXES = ["/jyl", "/plugins", "/resolvers", "/parsers", "/aliases"];

/**
 * Also browser-denied (security audits 2026-11-19): routes that drive a real
 * browser or touch stored secrets without being "scripting" — persona
 * warmups (navigate, click, start profiles), live code resolution, and the
 * AYCD key slot. A page inside a profile must never reach them.
 */
const SENSITIVE_PATTERNS = [
  /^\/profiles\/[^/]+\/warmup(\/|$)/,
  /^\/profiles\/[^/]+\/resolve$/,
  /^\/warmups\/personas(\/|$)/,
  /^\/integrations\/aycd(\/|$)/,
  // J3a: tab state holds resolved codes and passcodes.
  /^\/profiles\/[^/]+\/tab-state(\/|$)/,
  /^\/tab-state(\/|$)/,
  /^\/tab-view$/,
  // J6: Discord webhook + cookie export, the queue-position log, tools.
  /^\/integrations\/discord(\/|$)/,
  /^\/profiles\/[^/]+\/discord(\/|$)/,
  /^\/queue-positions$/,
  /^\/tools(\/|$)/,
  // ADR-0008: the Deck re-parents real windows.
  /^\/deck(\/|$)/,
  // Audit: cookie import / clear / export are side-effecting too.
  /^\/profiles\/[^/]+\/cookies(\/|$)/,
  // LIC: the redeemed team key.
  /^\/team(\/|$)/,
  // Audit: tab commands, tab export, notes, and every autofill route (card numbers).
  /^\/profiles\/[^/]+\/tabs(\/|$)/,
  /^\/tabs(\/|$)/,
  /^\/profiles\/[^/]+\/log-note$/,
  /^\/profiles\/[^/]+\/autofill(\/|$)/,
  // J7/J8: commands, preference sets, tab strings, network logs.
  /^\/commands(\/|$)/,
  /^\/presets(\/|$)/,
  /^\/profiles\/[^/]+\/(tab-string|netlog)(\/|$)/,
  // J5: cookie lists hold session cookies.
  /^\/cookie-thinger(\/|$)/,
  /^\/profiles\/[^/]+\/cookie-thinger(\/|$)/,
  // J4: autofill map fills move card numbers, codes and passcodes.
  /^\/autofill(\/|$)/,
  /^\/profiles\/[^/]+\/autofill\/map$/,
  // Audit M2: the "sites" settings section flips Discord export and page clicks.
  /^\/settings(\/|$)/,
];

function isScriptingUrl(url: string): boolean {
  // Match what the router matches (security audit 2026-11-19): the router
  // percent-decodes, so "/%74ab-view" must count as "/tab-view". Also fold
  // repeated slashes and drop ";params". An undecodable path is treated as
  // sensitive (the origin checks then apply).
  let path = url.split("?")[0] ?? url;
  try {
    path = decodeURIComponent(path);
  } catch {
    return true;
  }
  path = path.split(";")[0]!.replace(/\/{2,}/g, "/");
  return (
    SCRIPTING_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`)) ||
    SENSITIVE_PATTERNS.some((re) => re.test(path))
  );
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

export function denyBrowserScriptingRequest(
  req: FastifyRequest,
  reply: FastifyReply,
): void {
  if (!isScriptingUrl(req.url)) return;

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
        message: "cross-site requests to scripting endpoints are refused",
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
          message: "cross-origin requests to scripting endpoints are refused",
        },
      });
    }
  }
}

/** Register the deny hook on an app (kept as a function for testability). */
export function registerScriptingOriginDeny(app: FastifyInstance): void {
  app.addHook("onRequest", async (req, reply) => denyBrowserScriptingRequest(req, reply));
}
