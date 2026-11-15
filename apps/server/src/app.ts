import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { MAX_BUNDLE_BYTES, type TeamRole, type TeamServerConfig } from "./config.js";
import { TeamServerStore } from "./store.js";

/**
 * Team server HTTP surface (P7.7a). Design rules:
 * - The server is a durable mailbox for SEALED bundles — payloads are opaque
 *   bytes end to end; there is no decrypt path on this box at all.
 * - Every route except /health requires a bearer token (SHA-256 verified).
 * - Roles are coarse and honest: viewer reads, operator reads+writes
 *   bundles, admin also manages tokens. Per-profile leases (who may START a
 *   profile) are P7.7b — deliberately not half-wired here.
 */

interface Auth {
  role: TeamRole;
  name: string;
}

declare module "fastify" {
  interface FastifyRequest {
    teamAuth: Auth;
  }
}

export interface TeamServerApp {
  app: FastifyInstance;
  store: TeamServerStore;
  close: () => Promise<void>;
}

export function buildTeamServerApp(config: TeamServerConfig): TeamServerApp {
  const store = new TeamServerStore(config.dbPath);
  const app = Fastify({
    bodyLimit: MAX_BUNDLE_BYTES + 4096,
    logger: false,
  });

  // Bundle pushes arrive as raw bytes — collect any unmatched content type
  // (application/octet-stream included) into a Buffer untouched.
  app.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => {
    done(null, body);
  });

  function authenticate(req: FastifyRequest): Auth | null {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) return null;
    const token = header.slice("Bearer ".length).trim();
    if (!token) return null;
    if (config.adminToken && timingSafeStringEqual(token, config.adminToken)) {
      return { role: "admin", name: "env-admin" };
    }
    return store.authenticate(token);
  }

  app.get("/health", async () => ({
    ok: true,
    name: "queuepilot-team-server",
    bundles: store.listBundles().length,
  }));

  app.addHook("preHandler", async (req, reply) => {
    if (req.url === "/health" || req.url === "/health/") return;
    const auth = authenticate(req);
    if (!auth) {
      return reply
        .code(401)
        .send({ error: { code: "UNAUTHORIZED", message: "missing or invalid bearer token" } });
    }
    req.teamAuth = auth;
  });

  function requireRole(req: FastifyRequest, reply: FastifyReply, roles: TeamRole[]): boolean {
    if (roles.includes(req.teamAuth.role)) return true;
    reply
      .code(403)
      .send({ error: { code: "FORBIDDEN", message: `requires ${roles.join(" or ")}` } });
    return false;
  }

  // ---- token management (admin only; plaintext shown exactly once) ----

  app.get("/tokens", async (req, reply) => {
    if (!requireRole(req, reply, ["admin"])) return;
    return { tokens: store.listTokens() };
  });

  app.post("/tokens", async (req, reply) => {
    if (!requireRole(req, reply, ["admin"])) return;
    const body = (req.body ?? {}) as { name?: unknown; role?: unknown };
    const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : null;
    const role = body.role === "operator" || body.role === "viewer" || body.role === "admin" ? body.role : null;
    if (!name || !role) {
      return reply.code(400).send({
        error: { code: "VALIDATION_FAILED", message: 'body must be {name: string, role: "admin"|"operator"|"viewer"}' },
      });
    }
    const { record, token } = store.mintToken(name, role);
    return reply.code(201).send({ token, ...record });
  });

  app.delete<{ Params: { id: string } }>("/tokens/:id", async (req, reply) => {
    if (!requireRole(req, reply, ["admin"])) return;
    if (!store.deleteToken(req.params.id)) {
      return reply.code(404).send({ error: { code: "NOT_FOUND", message: "token not found" } });
    }
    return { deleted: req.params.id };
  });

  // ---- bundle mailbox (viewer reads, operator writes) ----

  app.get("/bundles", async () => ({ bundles: store.listBundles() }));

  app.get<{ Params: { profileId: string } }>("/bundles/:profileId", async (req, reply) => {
    const found = store.pullBundle(req.params.profileId);
    if (!found) {
      return reply.code(404).send({ error: { code: "NOT_FOUND", message: "no bundle for this profile" } });
    }
    reply.header("x-revision", String(found.head.revision));
    reply.header("x-updated-by", found.head.updatedBy);
    reply.header("x-updated-at", found.head.updatedAt);
    reply.header("content-type", "application/octet-stream");
    return reply.send(found.payload);
  });

  app.put<{ Params: { profileId: string }; Querystring: { baseRevision?: string } }>(
    "/bundles/:profileId",
    async (req, reply) => {
      if (!requireRole(req, reply, ["admin", "operator"])) return;
      const profileId = req.params.profileId;
      if (!/^[\w.-]{1,128}$/.test(profileId)) {
        return reply.code(400).send({ error: { code: "VALIDATION_FAILED", message: "profileId must be 1-128 of [A-Za-z0-9_.-]" } });
      }
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        return reply.code(400).send({ error: { code: "VALIDATION_FAILED", message: "body must be the sealed bundle bytes (application/octet-stream)" } });
      }
      if (body.length > MAX_BUNDLE_BYTES) {
        return reply.code(413).send({ error: { code: "PAYLOAD_TOO_LARGE", message: `bundle exceeds ${MAX_BUNDLE_BYTES} bytes` } });
      }
      let baseRevision: number | undefined;
      if (req.query.baseRevision !== undefined) {
        const n = Number(req.query.baseRevision);
        if (!Number.isInteger(n) || n < 0) {
          return reply.code(400).send({ error: { code: "VALIDATION_FAILED", message: "baseRevision must be a non-negative integer" } });
        }
        baseRevision = n;
      }
      const result = store.pushBundle(profileId, body, req.teamAuth.name, baseRevision);
      if ("conflict" in result) {
        return reply.code(409).send({
          error: {
            code: "REVISION_CONFLICT",
            message: `stored revision is ${result.conflict}; pull and rebase before pushing`,
            currentRevision: result.conflict,
          },
        });
      }
      return { profileId, revision: result.revision };
    },
  );

  app.delete<{ Params: { profileId: string } }>("/bundles/:profileId", async (req, reply) => {
    if (!requireRole(req, reply, ["admin", "operator"])) return;
    if (!store.deleteBundle(req.params.profileId)) {
      return reply.code(404).send({ error: { code: "NOT_FOUND", message: "no bundle for this profile" } });
    }
    return { deleted: req.params.profileId };
  });

  return { app, store, close: () => app.close() };
}

/** Constant-time string compare for the env bootstrap token. */
function timingSafeStringEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ba.length; i++) diff |= ba[i]! ^ bb[i]!;
  return diff === 0;
}
