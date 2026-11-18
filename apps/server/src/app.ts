import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import Database from "better-sqlite3";
import { MAX_BUNDLE_BYTES, type TeamRole, type TeamServerConfig } from "./config.js";
import { TeamServerStore } from "./store.js";
import { AuthStore, TEAM_MEMBER_CAP, type AccountRecord, type AccountTier } from "./auth-store.js";

/**
 * Team server HTTP surface (P7.7a + hosted team deployment 2026-11-17).
 * Design rules:
 * - The server is a durable mailbox for SEALED bundles — payloads are opaque
 *   bytes end to end; there is no decrypt path on this box at all.
 * - Every route except /health and the public auth routes requires a bearer
 *   credential: a minted device token (machines) or a session token (humans).
 * - Device tokens keep their historical roles (admin/operator/viewer) —
 *   existing desktop clients are untouched by the account system.
 * - Human accounts carry tiers per the owner's spec:
 *     L1  run tasks/warmups only (leases), read listings — no edits
 *     L2  + edit (push rebased bundles)
 *     L3  + add/delete profiles
 *     owner  + team management (invites, roles, cap of 10 members)
 */

interface Auth {
  /** Device-token role (null for session auth). Historical axis. */
  role: TeamRole | null;
  /** Session-account tier (null for device auth). New axis. */
  tier: AccountTier | null;
  name: string;
  accountId: string | null;
}

declare module "fastify" {
  interface FastifyRequest {
    teamAuth: Auth;
  }
}

export interface TeamServerApp {
  app: FastifyInstance;
  store: TeamServerStore;
  authStore: AuthStore;
  close: () => Promise<void>;
}

/** Bundle listing metadata is client-opaque; cap it defensively. */
const MAX_META_BYTES = 4 * 1024;

export function buildTeamServerApp(config: TeamServerConfig): TeamServerApp {
  // One shared connection: TeamServerStore and AuthStore must see the SAME
  // database — with ":memory:" (tests) two connections would be two DBs.
  const db = new Database(config.dbPath);
  db.pragma("journal_mode = WAL");
  const store = new TeamServerStore(db);
  const authStore = new AuthStore(db);
  const app = Fastify({
    bodyLimit: MAX_BUNDLE_BYTES + 4096,
    logger: false,
  });

  // Bundle pushes arrive as raw bytes — collect any unmatched content type
  // (application/octet-stream included) into a Buffer untouched.
  app.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => {
    done(null, body);
  });

  // ---- tiny in-memory rate limiter for the public auth routes ----
  const rateHits = new Map<string, { count: number; resetAt: number }>();
  function rateLimited(key: string, limit: number, windowMs: number): boolean {
    const now = Date.now();
    const hit = rateHits.get(key);
    if (!hit || hit.resetAt <= now) {
      rateHits.set(key, { count: 1, resetAt: now + windowMs });
      // opportunistic sweep so the map can't grow without bound
      if (rateHits.size > 5000) {
        for (const [k, v] of rateHits) if (v.resetAt <= now) rateHits.delete(k);
      }
      return false;
    }
    hit.count += 1;
    return hit.count > limit;
  }

  function authenticate(req: FastifyRequest): Auth | null {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) return null;
    const token = header.slice("Bearer ".length).trim();
    if (!token) return null;
    if (config.adminToken && timingSafeStringEqual(token, config.adminToken)) {
      return { role: "admin", tier: "owner", name: "env-admin", accountId: null };
    }
    const device = store.authenticate(token);
    if (device) {
      return { role: device.role, tier: null, name: device.name, accountId: null };
    }
    if (token.startsWith("qps_")) {
      const account = authStore.authenticateSession(token);
      if (account) {
        return { role: null, tier: account.tier, name: account.displayName, accountId: account.id };
      }
    }
    return null;
  }

  // ---- permission resolution: device role OR account tier ----

  /** Owner-only surface: token management + team management. */
  function isOwner(auth: Auth): boolean {
    return auth.role === "admin" || auth.tier === "owner";
  }

  /** Push/rebase bundles: device admin|operator; accounts owner|L3|L2. */
  function canWriteBundles(auth: Auth): boolean {
    if (auth.role === "admin" || auth.role === "operator") return true;
    return auth.tier === "owner" || auth.tier === "L3" || auth.tier === "L2";
  }

  /**
   * Delete bundles (= delete profiles). Legacy device tokens keep their
   * historical rights (admin AND operator could delete since P7.7a);
   * human accounts follow the owner's tier spec: owner|L3 only.
   */
  function canDeleteBundles(auth: Auth): boolean {
    if (auth.role) return auth.role === "admin" || auth.role === "operator";
    return auth.tier === "owner" || auth.tier === "L3";
  }

  /**
   * Launch leases (run tasks/warmups). Legacy device tokens keep their
   * historical rights (viewer was read-only and still is); every human
   * tier including L1 can run profiles — that is the L1 job description.
   */
  function canRunProfiles(auth: Auth): boolean {
    if (auth.role) return auth.role === "admin" || auth.role === "operator";
    return true;
  }

  /**
   * Liveness probe. Audit GPT-5.4 finding 4b: unauthenticated callers get
   * ONLY `{ ok: true }` — server identity and bundle counts are metadata a
   * port-scanner shouldn't harvest. Anything carrying a valid bearer token
   * (admin, operator, or viewer) gets the full detail.
   */
  app.get("/health", async (req) => {
    const auth = authenticate(req);
    if (!auth) return { ok: true };
    return {
      ok: true,
      name: "queuepilot-team-server",
      bundles: store.listBundles().length,
      role: auth.role ?? auth.tier,
    };
  });

  /** Public routes (bootstrap/signin/redeem) skip the bearer gate. */
  const PUBLIC_ROUTES = new Set(["/auth/bootstrap", "/auth/signin", "/auth/redeem"]);

  app.addHook("preHandler", async (req, reply) => {
    if (req.url === "/health" || req.url === "/health/") return;
    const pathOnly = req.url.split("?")[0]!;
    if (PUBLIC_ROUTES.has(pathOnly) && req.method === "POST") return;
    const auth = authenticate(req);
    if (!auth) {
      return reply
        .code(401)
        .send({ error: { code: "UNAUTHORIZED", message: "missing or invalid bearer token" } });
    }
    req.teamAuth = auth;
  });

  function forbidden(reply: FastifyReply, need: string): boolean {
    reply.code(403).send({ error: { code: "FORBIDDEN", message: `requires ${need}` } });
    return false;
  }

  function requireOwner(req: FastifyRequest, reply: FastifyReply): boolean {
    return isOwner(req.teamAuth) || forbidden(reply, "owner");
  }

  function requireRole(req: FastifyRequest, reply: FastifyReply, roles: TeamRole[]): boolean {
    if (req.teamAuth.role && roles.includes(req.teamAuth.role)) return true;
    // Device tokens map onto tiers for the legacy coarse checks:
    // admin→owner, operator→L2, viewer→L1.
    const tier = req.teamAuth.tier;
    if (tier === "owner" && roles.includes("admin")) return true;
    if (tier === "L3" && (roles.includes("admin") || roles.includes("operator"))) return true;
    if (tier === "L2" && roles.includes("operator")) return true;
    return forbidden(reply, roles.join(" or "));
  }

  // ---- public auth routes (rate-limited) ----

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function clientIp(req: FastifyRequest): string {
    return (req.headers["x-real-ip"] as string | undefined) ?? req.ip;
  }

  /**
   * One-time owner bootstrap: works ONLY while no owner account exists and
   * only with the env bootstrap code. After the owner exists this route is
   * dead — there is no second path to owner.
   */
  app.post("/auth/bootstrap", async (req, reply) => {
    const ip = clientIp(req);
    if (rateLimited(`bootstrap:${ip}`, 5, 60_000)) {
      return reply.code(429).send({ error: { code: "RATE_LIMITED", message: "too many attempts, wait a minute" } });
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const code = typeof body.code === "string" ? body.code : null;
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : null;
    const password = typeof body.password === "string" ? body.password : null;
    const displayName = typeof body.displayName === "string" && body.displayName.trim() ? body.displayName.trim() : null;
    if (!code || !config.bootstrapCode || !timingSafeStringEqual(code, config.bootstrapCode)) {
      return reply.code(403).send({ error: { code: "FORBIDDEN", message: "invalid bootstrap code" } });
    }
    if (authStore.hasOwner()) {
      return reply.code(409).send({ error: { code: "OWNER_EXISTS", message: "an owner account already exists — sign in instead" } });
    }
    if (!email || !EMAIL_RE.test(email) || !password || password.length < 10 || !displayName) {
      return reply.code(400).send({
        error: { code: "VALIDATION_FAILED", message: "body must be {code, email, password (min 10 chars), displayName}" },
      });
    }
    const account = await authStore.createAccount(email, password, displayName, "owner");
    const { token, expiresAt } = authStore.createSession(account.id);
    return reply.code(201).send({ token, expiresAt, account: publicAccount(account) });
  });

  app.post("/auth/signin", async (req, reply) => {
    const ip = clientIp(req);
    if (rateLimited(`signin:${ip}`, 5, 60_000)) {
      return reply.code(429).send({ error: { code: "RATE_LIMITED", message: "too many attempts, wait a minute" } });
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : null;
    const password = typeof body.password === "string" ? body.password : null;
    if (!email || !password) {
      return reply.code(400).send({ error: { code: "VALIDATION_FAILED", message: "body must be {email, password}" } });
    }
    const account = await authStore.verifyPassword(email, password);
    if (!account) {
      // Uniform message — never leak which half was wrong.
      return reply.code(401).send({ error: { code: "INVALID_CREDENTIALS", message: "invalid email or password" } });
    }
    const { token, expiresAt } = authStore.createSession(account.id);
    return { token, expiresAt, account: publicAccount(account) };
  });

  /** Invite redemption → a fresh account at the invite's tier. */
  app.post("/auth/redeem", async (req, reply) => {
    const ip = clientIp(req);
    if (rateLimited(`redeem:${ip}`, 20, 60_000)) {
      return reply.code(429).send({ error: { code: "RATE_LIMITED", message: "too many attempts, wait a minute" } });
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const code = typeof body.code === "string" ? body.code : null;
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : null;
    const password = typeof body.password === "string" ? body.password : null;
    const displayName = typeof body.displayName === "string" && body.displayName.trim() ? body.displayName.trim() : null;
    if (!code || !email || !EMAIL_RE.test(email) || !password || password.length < 10 || !displayName) {
      return reply.code(400).send({
        error: { code: "VALIDATION_FAILED", message: "body must be {code, email, password (min 10 chars), displayName}" },
      });
    }
    if (authStore.getAccountByEmail(email)) {
      return reply.code(409).send({ error: { code: "EMAIL_TAKEN", message: "an account with this email already exists" } });
    }
    if (authStore.memberCount() >= TEAM_MEMBER_CAP) {
      return reply.code(409).send({ error: { code: "TEAM_FULL", message: `team is capped at ${TEAM_MEMBER_CAP} members` } });
    }
    const redeemed = authStore.redeemInvite(code, email);
    if (!redeemed) {
      return reply.code(400).send({ error: { code: "INVALID_INVITE", message: "invite code is invalid, expired, or already used" } });
    }
    const account = await authStore.createAccount(email, password, displayName, redeemed.role);
    const { token, expiresAt } = authStore.createSession(account.id);
    return reply.code(201).send({ token, expiresAt, account: publicAccount(account) });
  });

  app.post("/auth/signout", async (req) => {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
    return { signedOut: token ? authStore.deleteSession(token) : false };
  });

  app.get("/auth/me", async (req) => {
    const auth = req.teamAuth;
    if (auth.accountId) {
      const account = authStore.getAccount(auth.accountId);
      return { account: account ? publicAccount(account) : null };
    }
    return { device: { role: auth.role, name: auth.name } };
  });

  function publicAccount(a: AccountRecord) {
    return { id: a.id, email: a.email, displayName: a.displayName, tier: a.tier, active: a.active, createdAt: a.createdAt };
  }

  // ---- team management (owner only) ----

  app.get("/team/members", async (req, reply) => {
    if (!requireOwner(req, reply)) return;
    return { members: authStore.listAccounts().map(publicAccount), cap: TEAM_MEMBER_CAP };
  });

  app.post("/team/invites", async (req, reply) => {
    if (!requireOwner(req, reply)) return;
    const body = (req.body ?? {}) as { role?: unknown };
    const role = body.role === "L1" || body.role === "L2" || body.role === "L3" ? (body.role as AccountTier) : null;
    if (!role) {
      return reply.code(400).send({ error: { code: "VALIDATION_FAILED", message: 'body must be {role: "L1"|"L2"|"L3"}' } });
    }
    const activeMembers = authStore.memberCount();
    const outstanding = authStore.listInvites().filter((i) => i.usedAt === null && Date.parse(i.expiresAt) > Date.now()).length;
    if (activeMembers + outstanding >= TEAM_MEMBER_CAP) {
      return reply.code(409).send({ error: { code: "TEAM_FULL", message: `team is capped at ${TEAM_MEMBER_CAP} members (active + outstanding invites)` } });
    }
    const { record, code } = authStore.createInvite(role, req.teamAuth.name);
    return reply.code(201).send({ code, invite: record });
  });

  app.get("/team/invites", async (req, reply) => {
    if (!requireOwner(req, reply)) return;
    return { invites: authStore.listInvites() };
  });

  app.delete<{ Params: { id: string } }>("/team/invites/:id", async (req, reply) => {
    if (!requireOwner(req, reply)) return;
    if (!authStore.revokeInvite(req.params.id)) {
      return reply.code(404).send({ error: { code: "NOT_FOUND", message: "invite not found" } });
    }
    return { revoked: req.params.id };
  });

  app.patch<{ Params: { id: string } }>("/team/members/:id", async (req, reply) => {
    if (!requireOwner(req, reply)) return;
    const body = (req.body ?? {}) as { role?: unknown; active?: unknown };
    const target = authStore.getAccount(req.params.id);
    if (!target) {
      return reply.code(404).send({ error: { code: "NOT_FOUND", message: "member not found" } });
    }
    if (target.tier === "owner") {
      return reply.code(409).send({ error: { code: "OWNER_IMMUTABLE", message: "the owner account cannot be edited here" } });
    }
    let changed = false;
    if (body.role !== undefined) {
      const role = body.role === "L1" || body.role === "L2" || body.role === "L3" ? (body.role as AccountTier) : null;
      if (!role) {
        return reply.code(400).send({ error: { code: "VALIDATION_FAILED", message: 'role must be "L1"|"L2"|"L3"' } });
      }
      changed = authStore.setAccountTier(target.id, role) || changed;
    }
    if (body.active !== undefined) {
      changed = authStore.setAccountActive(target.id, body.active === true) || changed;
    }
    const updated = authStore.getAccount(target.id)!;
    return { account: publicAccount(updated), changed };
  });

  app.delete<{ Params: { id: string } }>("/team/members/:id", async (req, reply) => {
    if (!requireOwner(req, reply)) return;
    const target = authStore.getAccount(req.params.id);
    if (!target) {
      return reply.code(404).send({ error: { code: "NOT_FOUND", message: "member not found" } });
    }
    if (target.tier === "owner") {
      return reply.code(409).send({ error: { code: "OWNER_IMMUTABLE", message: "the owner account cannot be deleted" } });
    }
    authStore.deleteAccount(req.params.id);
    return { deleted: req.params.id };
  });

  // ---- token management (owner only; plaintext shown exactly once) ----
  //
  // Device admin tokens still pass requireOwner — they were the historical
  // admins — but L3 (manager tier) deliberately cannot mint or revoke
  // device credentials: managing who can CONNECT is an owner function.

  app.get("/tokens", async (req, reply) => {
    if (!requireOwner(req, reply)) return;
    return { tokens: store.listTokens() };
  });

  app.post("/tokens", async (req, reply) => {
    if (!requireOwner(req, reply)) return;
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
    if (!requireOwner(req, reply)) return;
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

  app.put<{ Params: { profileId: string }; Querystring: { baseRevision?: string; meta?: string } }>(
    "/bundles/:profileId",
    async (req, reply) => {
      if (!canWriteBundles(req.teamAuth)) return forbidden(reply, "L2 (edit) or above");
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
      let meta: string | undefined;
      if (req.query.meta !== undefined) {
        try {
          JSON.parse(req.query.meta); // validity check only — the server never interprets it
        } catch {
          return reply.code(400).send({ error: { code: "VALIDATION_FAILED", message: "meta must be URL-encoded JSON" } });
        }
        if (req.query.meta.length > MAX_META_BYTES) {
          return reply.code(413).send({ error: { code: "PAYLOAD_TOO_LARGE", message: `meta exceeds ${MAX_META_BYTES} bytes` } });
        }
        meta = req.query.meta;
      }
      let baseRevision: number | undefined;
      if (req.query.baseRevision !== undefined) {
        const n = Number(req.query.baseRevision);
        if (!Number.isInteger(n) || n < 0) {
          return reply.code(400).send({ error: { code: "VALIDATION_FAILED", message: "baseRevision must be a non-negative integer" } });
        }
        baseRevision = n;
      }
      const result = store.pushBundle(profileId, body, req.teamAuth.name, baseRevision, meta);
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
    if (!canDeleteBundles(req.teamAuth)) return forbidden(reply, "L3 (manager) or above");
    if (!store.deleteBundle(req.params.profileId)) {
      return reply.code(404).send({ error: { code: "NOT_FOUND", message: "no bundle for this profile" } });
    }
    return { deleted: req.params.profileId };
  });

  // ---- per-profile launch leases (P7.7b): the cross-machine double-start guard ----

  app.get("/leases", async () => ({ leases: store.listLeases() }));

  app.get<{ Params: { profileId: string } }>("/leases/:profileId", async (req, reply) => {
    const lease = store.getLease(req.params.profileId);
    if (!lease) {
      return reply.code(404).send({ error: { code: "NOT_FOUND", message: "no live lease for this profile" } });
    }
    return lease;
  });

  app.post("/leases/acquire", async (req, reply) => {
    if (!canRunProfiles(req.teamAuth)) return forbidden(reply, "a signed-in team member");
    const body = (req.body ?? {}) as { profileId?: unknown; holder?: unknown; machine?: unknown; ttlMs?: unknown };
    const profileId = typeof body.profileId === "string" ? body.profileId : null;
    const holder = typeof body.holder === "string" ? body.holder : null;
    const machine = typeof body.machine === "string" && body.machine ? body.machine : "unknown";
    const ttlMs = typeof body.ttlMs === "number" && Number.isInteger(body.ttlMs)
      ? Math.min(Math.max(body.ttlMs, 5_000), 3_600_000)
      : 60_000;
    if (!profileId || !/^[\w.-]{1,128}$/.test(profileId) || !holder) {
      return reply.code(400).send({
        error: { code: "VALIDATION_FAILED", message: "body must be {profileId, holder, machine?, ttlMs?}" },
      });
    }
    const result = store.acquireLease(profileId, holder, machine, ttlMs);
    if (!result.acquired) {
      return reply.code(409).send({
        error: {
          code: "LEASE_HELD",
          message: `profile is held by ${result.heldBy} until ${result.expiresAt}`,
          heldBy: result.heldBy,
          expiresAt: result.expiresAt,
        },
      });
    }
    return reply.code(201).send({ profileId, holder, expiresAt: result.expiresAt });
  });

  app.post("/leases/renew", async (req, reply) => {
    if (!canRunProfiles(req.teamAuth)) return forbidden(reply, "a signed-in team member");
    const body = (req.body ?? {}) as { profileId?: unknown; holder?: unknown; ttlMs?: unknown };
    if (typeof body.profileId !== "string" || typeof body.holder !== "string") {
      return reply.code(400).send({
        error: { code: "VALIDATION_FAILED", message: "body must be {profileId, holder, ttlMs?}" },
      });
    }
    const ttlMs = typeof body.ttlMs === "number" && Number.isInteger(body.ttlMs)
      ? Math.min(Math.max(body.ttlMs, 5_000), 3_600_000)
      : 60_000;
    const expiresAt = store.renewLease(body.profileId, body.holder, ttlMs);
    if (!expiresAt) {
      return reply.code(409).send({
        error: { code: "LEASE_LOST", message: "lease is gone or held by someone else" },
      });
    }
    return { profileId: body.profileId, holder: body.holder, expiresAt };
  });

  app.post("/leases/release", async (req, reply) => {
    if (!canRunProfiles(req.teamAuth)) return forbidden(reply, "a signed-in team member");
    const body = (req.body ?? {}) as { profileId?: unknown; holder?: unknown };
    if (typeof body.profileId !== "string" || typeof body.holder !== "string") {
      return reply.code(400).send({
        error: { code: "VALIDATION_FAILED", message: "body must be {profileId, holder}" },
      });
    }
    return { released: store.releaseLease(body.profileId, body.holder) };
  });

  // Admin force-release: evict a stuck lease without being the holder.
  app.delete<{ Params: { profileId: string } }>("/leases/:profileId", async (req, reply) => {
    if (!requireRole(req, reply, ["admin"])) return;
    if (!store.forceReleaseLease(req.params.profileId)) {
      return reply.code(404).send({ error: { code: "NOT_FOUND", message: "no live lease for this profile" } });
    }
    return { released: req.params.profileId };
  });

  return {
    app,
    store,
    authStore,
    close: async () => {
      await app.close();
      db.close();
    },
  };
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
