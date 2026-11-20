import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { SettingsService } from "../application/settings/settings.service.js";
import {
  TeamServerClient,
  TeamServerError,
  teamCredential,
} from "../application/team/team-client.js";

/**
 * Hosted team client surface (2026-11-18). The dashboard only ever talks to
 * this local API; these routes relay sign-in and owner team management to
 * the configured team server (Settings → Team → serverUrl) with the
 * machine's credential (session token if signed in, else device token).
 *
 * Status mapping is deliberate: the dashboard treats a local 401 as "the
 * LOCAL API token was refused" and pops its own sign-in, so upstream auth
 * failures are NEVER relayed as 401 —
 *   wrong email/password     → 400 INVALID_CREDENTIALS
 *   upstream 401/403         → 403 (code from the server, e.g. FORBIDDEN)
 *   server unreachable       → 502 TEAM_UNAVAILABLE
 * Every other upstream status (409 TEAM_FULL / OWNER_IMMUTABLE, 404, 429…)
 * passes through with the server's own code and message, so the UI can
 * show it plainly.
 */

const SignInSchema = z.object({
  email: z.string().min(1).max(320),
  password: z.string().min(1).max(500),
});
const TierSchema = z.enum(["L1", "L2", "L3"]);
const InviteSchema = z.object({ role: TierSchema });
const MemberPatchSchema = z
  .object({ role: TierSchema.optional(), active: z.boolean().optional() })
  .refine((v) => v.role !== undefined || v.active !== undefined, { message: "role or active is required" });

function relayError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof TeamServerError) {
    const status = err.status === 401 || err.status === 403 ? 403 : err.status;
    return reply.code(status).send({ error: { code: err.code, message: err.message } });
  }
  const message = err instanceof Error ? err.message : String(err);
  return reply
    .code(502)
    .send({ error: { code: "TEAM_UNAVAILABLE", message: `team server unreachable: ${message}` } });
}

export function registerTeamRoutes(app: FastifyInstance, deps: { settings: SettingsService }): void {
  const { settings } = deps;

  function client(reply: FastifyReply): TeamServerClient | null {
    const team = settings.get("team");
    const cred = teamCredential(team);
    if (!team.serverUrl || !cred) {
      void reply
        .code(409)
        .send({ error: { code: "TEAM_NOT_CONFIGURED", message: "no team server configured or not signed in" } });
      return null;
    }
    return new TeamServerClient(team.serverUrl, cred.token);
  }

  /**
   * Who this machine is on the team server. Never throws: an offline or
   * unconfigured install gets {configured:false} and works exactly as before.
   */
  app.get("/team/session", async () => {
    const team = settings.get("team");
    const cred = teamCredential(team);
    const base = {
      configured: Boolean(team.serverUrl),
      serverUrl: team.serverUrl,
      source: team.serverUrl && cred ? cred.source : null,
    };
    if (!team.serverUrl || !cred) return { ...base, account: null, device: null, reachable: null };
    try {
      const me = await new TeamServerClient(team.serverUrl, cred.token).me();
      return { ...base, account: me.account ?? null, device: me.device ?? null, reachable: true };
    } catch (err) {
      if (err instanceof TeamServerError && err.status === 401 && cred.source === "session") {
        // Session expired or revoked server-side: drop it so the device
        // token (if any) takes over and the UI offers sign-in again.
        settings.patch("team", { sessionToken: null, sessionExpiresAt: null });
        return {
          ...base,
          source: team.token ? "device" : null,
          account: null,
          device: null,
          reachable: true,
          message: "your session expired — sign in again",
        };
      }
      return {
        ...base,
        account: null,
        device: null,
        reachable: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  });

  app.post("/team/signin", async (req, reply) => {
    const { email, password } = SignInSchema.parse(req.body);
    const team = settings.get("team");
    if (!team.serverUrl) {
      return reply
        .code(409)
        .send({ error: { code: "TEAM_NOT_CONFIGURED", message: "set the team server URL first (Settings → Team)" } });
    }
    try {
      const out = await TeamServerClient.signIn(team.serverUrl, email, password);
      settings.patch("team", { sessionToken: out.token, sessionExpiresAt: out.expiresAt });
      return { account: out.account, expiresAt: out.expiresAt };
    } catch (err) {
      if (err instanceof TeamServerError && err.status === 401) {
        return reply
          .code(400)
          .send({ error: { code: "INVALID_CREDENTIALS", message: "wrong email or password" } });
      }
      return relayError(reply, err);
    }
  });

  app.post("/team/signout", async () => {
    const team = settings.get("team");
    if (team.serverUrl && team.sessionToken) {
      // Best effort: revoke server-side; the local copy is dropped regardless.
      await new TeamServerClient(team.serverUrl, team.sessionToken).signOut().catch(() => {});
    }
    settings.patch("team", { sessionToken: null, sessionExpiresAt: null });
    return { signedOut: true };
  });

  // ---- owner team management (the server enforces owner-only) ----

  app.get("/team/members", async (_req, reply) => {
    const c = client(reply);
    if (!c) return reply;
    try {
      return await c.listMembers();
    } catch (err) {
      return relayError(reply, err);
    }
  });

  app.patch("/team/members/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const patch = MemberPatchSchema.parse(req.body);
    const c = client(reply);
    if (!c) return reply;
    try {
      return await c.updateMember(id, patch);
    } catch (err) {
      return relayError(reply, err);
    }
  });

  app.delete("/team/members/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const c = client(reply);
    if (!c) return reply;
    try {
      await c.removeMember(id);
      return { deleted: id };
    } catch (err) {
      return relayError(reply, err);
    }
  });

  app.get("/team/invites", async (_req, reply) => {
    const c = client(reply);
    if (!c) return reply;
    try {
      return await c.listInvites();
    } catch (err) {
      return relayError(reply, err);
    }
  });

  app.post("/team/invites", async (req, reply) => {
    const { role } = InviteSchema.parse(req.body);
    const c = client(reply);
    if (!c) return reply;
    try {
      return reply.code(201).send(await c.createInvite(role));
    } catch (err) {
      return relayError(reply, err);
    }
  });

  app.delete("/team/invites/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const c = client(reply);
    if (!c) return reply;
    try {
      await c.revokeInvite(id);
      return { revoked: id };
    } catch (err) {
      return relayError(reply, err);
    }
  });
}
