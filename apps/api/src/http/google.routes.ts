import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { GoogleAuthService } from "../application/google/google-auth.service.js";

/**
 * Google connection routes (loopback OAuth desktop flow). The user opens the
 * URL from /google/auth/url, consents in their browser, and Google redirects
 * back to /google/auth/callback on this same loopback server.
 */
export function registerGoogleRoutes(
  app: FastifyInstance,
  google: GoogleAuthService,
): void {
  app.get("/google/auth/status", async () => google.status());

  app.get("/google/auth/url", async () => {
    const url = google.authUrl(randomUUID());
    return { url };
  });

  app.get("/google/auth/callback", async (req, reply) => {
    const { code, error } = req.query as { code?: string; error?: string };
    if (error || !code) {
      return reply
        .code(400)
        .type("text/html")
        .send(
          `<html><body><h3>Google connection failed</h3><p>${error ?? "no code returned"}</p></body></html>`,
        );
    }
    await google.handleCallback(code);
    return reply
      .type("text/html")
      .send(
        "<html><body><h3>Google connected to QueuePilot.</h3><p>You can close this tab.</p></body></html>",
      );
  });

  app.post("/google/auth/disconnect", async () => {
    google.disconnect();
    return { connected: false };
  });
}
