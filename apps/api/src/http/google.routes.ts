import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  GoogleAuthService,
  SHEETS_ACCOUNT,
  SHEETS_SCOPE,
} from "../application/google/google-auth.service.js";

/**
 * Google connection routes (loopback OAuth desktop flow, PKCE). The user
 * opens the URL from /google/auth/url, consents in their browser, and Google
 * redirects back to /google/auth/callback on this same loopback server.
 * Multi-account: Sheets uses the fixed "sheets" account; the gmail resolver
 * uses one account per mail identity.
 */
export function registerGoogleRoutes(
  app: FastifyInstance,
  google: GoogleAuthService,
): void {
  app.get("/google/auth/status", async () => google.status());

  app.get("/google/auth/accounts", async () => ({ accounts: google.accounts() }));

  const StartSchema = z.object({
    account: z.string().min(1).max(200).default(SHEETS_ACCOUNT),
    scopes: z.string().min(1).max(2000).optional(),
  });

  app.get("/google/auth/url", async (req) => {
    const { account, scopes } = StartSchema.parse(req.query ?? {});
    const scopeList = scopes
      ? scopes.split(/\s+/).filter(Boolean)
      : [SHEETS_SCOPE];
    const { url } = google.start(account, scopeList);
    return { account, url };
  });

  app.get("/google/auth/callback", async (req, reply) => {
    const { state, code, error } = req.query as {
      state?: string;
      code?: string;
      error?: string;
    };
    // P0 audit SEC-1: every reflected value is HTML-escaped. The old page
    // wrote the `error` query value raw into HTML — a reflected XSS on the
    // API's own origin, reachable from any page (incl. one inside a profile).
    const esc = (s: unknown) =>
      String(s ?? "").replace(
        /[&<>"']/g,
        (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
      );
    const page = (title: string, body: string) =>
      reply
        .type("text/html")
        .send(
          `<html><body><h3>${esc(title)}</h3><p>${body}</p></body></html>`,
        );
    if (error || !code || !state) {
      return page(
        "Google connection failed",
        esc(error ?? "no code returned"),
      );
    }
    try {
      const { account } = await google.complete(state, code);
      // `account` is reflected only after google.complete() validated the
      // state — an attacker can't inject it without a valid code+state.
      return page(
        "Google connected to QueuePilot.",
        `Account <b>${esc(account)}</b> is connected. You can close this tab.`,
      );
    } catch (err) {
      return page(
        "Google connection failed",
        esc(err instanceof Error ? err.message : String(err)),
      );
    }
  });

  const DisconnectSchema = z.object({
    account: z.string().min(1).max(200).default(SHEETS_ACCOUNT),
  });

  app.post("/google/auth/disconnect", async (req) => {
    const { account } = DisconnectSchema.parse(req.body ?? {});
    google.disconnect(account);
    return { account, connected: false };
  });
}
