import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_BUNDLE_BYTES, type TeamRole, type TeamServerConfig } from "./config.js";
import { PENDING_OWNER_ID, TeamServerStore } from "./store.js";
import { AuthStore, TEAM_MEMBER_CAP, accountUsable, type AccountRecord, type AccountTier } from "./auth-store.js";
import { WarmupPlanner } from "./warmup/service.js";

/**
 * Team server HTTP surface (P7.7a + hosted team deployment 2026-11-17).
 * Design rules:
 * - The server is a durable mailbox for SEALED bundles — payloads are opaque
 *   bytes end to end; there is no decrypt path on this box at all.
 * - Every route except /health and the public auth routes requires a bearer
 *   credential: a minted device token (machines) or a session token (humans).
 * - ACCOUNT ISOLATION (owner decision 2026-11-20, supersedes the L1/L2/L3
 *   tier model): every account is a private island. Bundles, leases and
 *   warmup settings are keyed by the caller's account; another account's
 *   profile id answers 404, never 403, so ids don't leak.
 * - A credential resolves to exactly one account: a `qps_` sign-in session
 *   to its own account; an operator/viewer device token to the owner's
 *   account (device tokens are the owner's machines). Admin credentials
 *   (the env admin token, admin device tokens) belong to no account: they
 *   manage accounts and are refused on every content route.
 * - The owner is the admin: invites (10-member cap), revoke, extend/expire,
 *   delete (which deletes that account's content). The owner reads only his
 *   own account's content, never another account's.
 * - Viewer device tokens are read-only; sessions and operator tokens read
 *   and write within their account.
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
  // AuthStore first: the store's isolation migration needs the owner account.
  const authStore = new AuthStore(db);
  const store = new TeamServerStore(db);
  const planner = new WarmupPlanner(
    store,
    config.personaDir === undefined ? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../personas") : config.personaDir,
  );
  const app = Fastify({
    bodyLimit: MAX_BUNDLE_BYTES + 4096,
    logger: false,
  });

  // Bundle pushes arrive as raw bytes — collect any unmatched content type
  // (application/octet-stream included) into a Buffer untouched.
  app.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => {
    done(null, body);
  });

  // Never echo internal error text (SQLite messages etc.) to a client (audit
  // L1). Fastify's own 4xx errors (bad JSON, body too large) keep their status.
  app.setErrorHandler((err: { statusCode?: number; code?: string; message: string }, _req, reply) => {
    const status = err.statusCode ?? 500;
    if (status < 500) {
      return reply.code(status).send({ error: { code: err.code ?? "BAD_REQUEST", message: err.message } });
    }
    console.error(`[team-server] ${err.message}`);
    return reply.code(500).send({ error: { code: "INTERNAL", message: "internal error" } });
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
      if (device.accountId === null) return { role: device.role, tier: null, name: device.name, accountId: null };
      // A device token is only as good as its account (parked pre-owner content excepted).
      if (device.accountId !== PENDING_OWNER_ID) {
        const acct = authStore.getAccount(device.accountId);
        if (!acct || !accountUsable(acct)) return null;
      }
      return { role: device.role, tier: null, name: device.name, accountId: device.accountId };
    }
    if (token.startsWith("qps_")) {
      const account = authStore.authenticateSession(token); // rejects inactive/expired accounts
      if (account) {
        return { role: null, tier: account.tier, name: account.displayName, accountId: account.id };
      }
    }
    return null;
  }

  // ---- permission resolution ----

  /** Owner-only surface: account (team) management + device tokens. */
  function isOwner(auth: Auth): boolean {
    return auth.role === "admin" || auth.tier === "owner";
  }

  /**
   * The caller's account for a content route, or null after replying 403.
   * Admin credentials have no account and therefore no content access at
   * all; viewer device tokens are read-only.
   */
  function contentAccount(req: FastifyRequest, reply: FastifyReply, write: boolean): string | null {
    const { accountId, role } = req.teamAuth;
    if (accountId === null) {
      forbidden(reply, "an account (admin credentials manage accounts and never read content)");
      return null;
    }
    if (write && role === "viewer") {
      forbidden(reply, "write access (viewer device keys are read-only)");
      return null;
    }
    return accountId;
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
    // Counts are per account; an admin credential sees only the account count.
    if (auth.accountId === null) {
      return { ok: true, name: "queuepilot-team-server", accounts: authStore.listAccounts().length, role: auth.role ?? auth.tier };
    }
    return {
      ok: true,
      name: "queuepilot-team-server",
      bundles: store.listBundles(auth.accountId).length,
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

  const notFound = (reply: FastifyReply, message: string) =>
    reply.code(404).send({ error: { code: "NOT_FOUND", message } });

  // ---- public auth routes (rate-limited) ----

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  /**
   * The caller's IP for rate limiting. `X-Real-IP` is honoured ONLY when the
   * TCP peer is loopback or a private address — i.e. the request came through
   * the deploy's nginx (host loopback → the container's Docker bridge), which
   * overwrites that header with the real client address. A client reaching
   * the port directly cannot pick its own rate-limit key (audit M1).
   */
  function clientIp(req: FastifyRequest): string {
    const forwarded = req.headers["x-real-ip"];
    const peer = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
    const trustedPeer =
      peer === "::1" ||
      /^127\./.test(peer) ||
      /^10\./.test(peer) ||
      /^192\.168\./.test(peer) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(peer) ||
      /^f[cd][0-9a-f]{2}:/i.test(peer);
    return trustedPeer && typeof forwarded === "string" && forwarded.trim() ? forwarded.trim() : req.ip;
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
    let account: AccountRecord;
    try {
      account = await authStore.createAccount(email, password, displayName, "owner");
    } catch {
      // Lost a concurrent bootstrap race: the one-owner index refused the second owner (audit M2).
      return reply.code(409).send({ error: { code: "OWNER_EXISTS", message: "an owner account already exists — sign in instead" } });
    }
    // Content from a pre-hosted server (parked at migration) becomes the owner's.
    store.adoptPendingContent(account.id);
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
    if (!email || !password || email.length > 254) {
      return reply.code(400).send({ error: { code: "VALIDATION_FAILED", message: "body must be {email, password}" } });
    }
    // Per-email too, so one account can't be ground at from many addresses (audit M1).
    if (rateLimited(`signin-email:${email}`, 10, 60_000)) {
      return reply.code(429).send({ error: { code: "RATE_LIMITED", message: "too many attempts, wait a minute" } });
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
    // The invite first: without a valid code, nothing else is answered (no email enumeration — audit L4).
    if (!authStore.inviteValid(code)) {
      return reply.code(400).send({ error: { code: "INVALID_INVITE", message: "invite code is invalid, expired, or already used" } });
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
    let account: AccountRecord;
    try {
      account = await authStore.createAccount(email, password, displayName, redeemed.role);
    } catch {
      // A concurrent redeem took this email first: give the invite back, answer plainly (audit L1).
      authStore.refundInvite(code);
      return reply.code(409).send({ error: { code: "EMAIL_TAKEN", message: "an account with this email already exists" } });
    }
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
    if (auth.role === null && auth.accountId) {
      const account = authStore.getAccount(auth.accountId);
      return { account: account ? publicAccount(account) : null };
    }
    return { device: { role: auth.role, name: auth.name } };
  });

  function publicAccount(a: AccountRecord) {
    return {
      id: a.id,
      email: a.email,
      displayName: a.displayName,
      tier: a.tier,
      active: a.active,
      createdAt: a.createdAt,
      expiresAt: a.expiresAt,
    };
  }

  /** `{days: n}` or `{expiresAt: ISO|null}` → ISO / null; undefined = not given; Error = invalid. */
  const MAX_EXPIRY_DAYS = 3650;
  function parseExpiry(body: { expiresAt?: unknown; days?: unknown }): string | null | undefined | Error {
    if (body.days !== undefined) {
      if (typeof body.days !== "number" || !Number.isInteger(body.days) || body.days < 1 || body.days > MAX_EXPIRY_DAYS) {
        return new Error(`days must be a whole number 1-${MAX_EXPIRY_DAYS}`);
      }
      return new Date(Date.now() + body.days * 86_400_000).toISOString();
    }
    if (body.expiresAt === null) return null;
    if (body.expiresAt === undefined) return undefined;
    if (typeof body.expiresAt !== "string" || Number.isNaN(Date.parse(body.expiresAt))) {
      return new Error("expiresAt must be an ISO date or null");
    }
    return new Date(Date.parse(body.expiresAt)).toISOString();
  }

  // ---- team management (owner only) ----

  app.get("/team/members", async (req, reply) => {
    if (!requireOwner(req, reply)) return;
    return { members: authStore.listAccounts().map(publicAccount), cap: TEAM_MEMBER_CAP };
  });

  app.post("/team/invites", async (req, reply) => {
    if (!requireOwner(req, reply)) return;
    // Tiers no longer gate anything (account isolation); `role` is still
    // accepted for older clients and stored, and defaults to a plain member.
    const body = (req.body ?? {}) as { role?: unknown };
    const role: AccountTier | null =
      body.role === undefined ? "L1" : body.role === "L1" || body.role === "L2" || body.role === "L3" ? (body.role as AccountTier) : null;
    if (!role) {
      return reply.code(400).send({ error: { code: "VALIDATION_FAILED", message: 'role, when given, must be "L1"|"L2"|"L3"' } });
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
    const body = (req.body ?? {}) as { role?: unknown; active?: unknown; expiresAt?: unknown; days?: unknown };
    const target = authStore.getAccount(req.params.id);
    if (!target) {
      return reply.code(404).send({ error: { code: "NOT_FOUND", message: "member not found" } });
    }
    if (target.tier === "owner") {
      return reply.code(409).send({ error: { code: "OWNER_IMMUTABLE", message: "the owner account cannot be edited here" } });
    }
    const expiry = parseExpiry(body);
    if (expiry instanceof Error) {
      return reply.code(400).send({ error: { code: "VALIDATION_FAILED", message: expiry.message } });
    }
    // An account that was unusable (deactivated, or lapsed on its own) must not
    // get its old sessions back when it is revived (audit L3 residual).
    if (!accountUsable(target)) authStore.deleteSessionsFor(target.id);
    let changed = false;
    if (expiry !== undefined) changed = authStore.setAccountExpiry(target.id, expiry) || changed;
    if (body.role !== undefined) {
      const role = body.role === "L1" || body.role === "L2" || body.role === "L3" ? (body.role as AccountTier) : null;
      if (!role) {
        return reply.code(400).send({ error: { code: "VALIDATION_FAILED", message: 'role must be "L1"|"L2"|"L3"' } });
      }
      changed = authStore.setAccountTier(target.id, role) || changed;
    }
    if (body.active !== undefined) {
      // Reactivation counts against the cap like a new member (audit L3).
      if (body.active === true && !target.active && authStore.memberCount() >= TEAM_MEMBER_CAP) {
        return reply.code(409).send({ error: { code: "TEAM_FULL", message: `team is capped at ${TEAM_MEMBER_CAP} members` } });
      }
      changed = authStore.setAccountActive(target.id, body.active === true) || changed;
    }
    const updated = authStore.getAccount(target.id)!;
    // Deactivated or expired: sign it out everywhere, so reviving it later
    // doesn't resurrect old sessions (audit L3).
    if (!accountUsable(updated)) authStore.deleteSessionsFor(updated.id);
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
    // The account's island goes with it — the owner never inherits a member's content.
    store.deleteAccountContent(req.params.id);
    return { deleted: req.params.id };
  });

  // ---- device tokens (owner only; plaintext shown exactly once) ----
  //
  // Device tokens are the owner's machines: an operator/viewer token belongs
  // to the owner's account, an admin token to no account.

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
    const { record, token } = store.mintToken(name, role, role === "admin" ? null : store.ownerAccountId());
    return reply.code(201).send({ token, ...record });
  });

  app.delete<{ Params: { id: string } }>("/tokens/:id", async (req, reply) => {
    if (!requireOwner(req, reply)) return;
    if (!store.deleteToken(req.params.id)) {
      return reply.code(404).send({ error: { code: "NOT_FOUND", message: "token not found" } });
    }
    return { deleted: req.params.id };
  });

  // ---- bundle mailbox (account-scoped; viewer device keys read-only) ----

  app.get("/bundles", async (req, reply) => {
    const accountId = contentAccount(req, reply, false);
    if (!accountId) return;
    return { bundles: store.listBundles(accountId) };
  });

  app.get<{ Params: { profileId: string } }>("/bundles/:profileId", async (req, reply) => {
    const accountId = contentAccount(req, reply, false);
    if (!accountId) return;
    const found = store.pullBundle(accountId, req.params.profileId);
    if (!found) return notFound(reply, "no bundle for this profile");
    reply.header("x-revision", String(found.head.revision));
    reply.header("x-updated-by", found.head.updatedBy);
    reply.header("x-updated-at", found.head.updatedAt);
    reply.header("content-type", "application/octet-stream");
    return reply.send(found.payload);
  });

  app.put<{ Params: { profileId: string }; Querystring: { baseRevision?: string; meta?: string } }>(
    "/bundles/:profileId",
    async (req, reply) => {
      const accountId = contentAccount(req, reply, true);
      if (!accountId) return;
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
      const result = store.pushBundle(accountId, profileId, body, req.teamAuth.name, baseRevision, meta);
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
    const accountId = contentAccount(req, reply, true);
    if (!accountId) return;
    if (!store.deleteBundle(accountId, req.params.profileId)) return notFound(reply, "no bundle for this profile");
    return { deleted: req.params.profileId };
  });

  // ---- per-profile launch leases (P7.7b): the cross-machine double-start guard ----

  app.get("/leases", async (req, reply) => {
    const accountId = contentAccount(req, reply, false);
    if (!accountId) return;
    return { leases: store.listLeases(accountId) };
  });

  app.get<{ Params: { profileId: string } }>("/leases/:profileId", async (req, reply) => {
    const accountId = contentAccount(req, reply, false);
    if (!accountId) return;
    const lease = store.getLease(accountId, req.params.profileId);
    if (!lease) return notFound(reply, "no live lease for this profile");
    return lease;
  });

  app.post("/leases/acquire", async (req, reply) => {
    const accountId = contentAccount(req, reply, true);
    if (!accountId) return;
    const body = (req.body ?? {}) as { profileId?: unknown; holder?: unknown; machine?: unknown; ttlMs?: unknown };
    const profileId = typeof body.profileId === "string" ? body.profileId : null;
    const holder = typeof body.holder === "string" ? body.holder : null;
    const machine = typeof body.machine === "string" && body.machine ? body.machine : "unknown";
    const ttlMs = typeof body.ttlMs === "number" && Number.isInteger(body.ttlMs)
      ? Math.min(Math.max(body.ttlMs, 5_000), 3_600_000)
      : 60_000;
    // Stored strings are capped: a member cannot bloat the shared DB through lease fields (audit M3).
    if (!profileId || !/^[\w.-]{1,128}$/.test(profileId) || !holder || holder.length > 256 || machine.length > 256) {
      return reply.code(400).send({
        error: { code: "VALIDATION_FAILED", message: "body must be {profileId, holder (≤256), machine? (≤256), ttlMs?}" },
      });
    }
    const result = store.acquireLease(accountId, profileId, holder, machine, ttlMs);
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
    const accountId = contentAccount(req, reply, true);
    if (!accountId) return;
    const body = (req.body ?? {}) as { profileId?: unknown; holder?: unknown; ttlMs?: unknown };
    if (typeof body.profileId !== "string" || !/^[\w.-]{1,128}$/.test(body.profileId) || typeof body.holder !== "string" || body.holder.length > 256) {
      return reply.code(400).send({
        error: { code: "VALIDATION_FAILED", message: "body must be {profileId, holder, ttlMs?}" },
      });
    }
    const ttlMs = typeof body.ttlMs === "number" && Number.isInteger(body.ttlMs)
      ? Math.min(Math.max(body.ttlMs, 5_000), 3_600_000)
      : 60_000;
    const expiresAt = store.renewLease(accountId, body.profileId, body.holder, ttlMs);
    if (!expiresAt) {
      return reply.code(409).send({
        error: { code: "LEASE_LOST", message: "lease is gone or held by someone else" },
      });
    }
    return { profileId: body.profileId, holder: body.holder, expiresAt };
  });

  app.post("/leases/release", async (req, reply) => {
    const accountId = contentAccount(req, reply, true);
    if (!accountId) return;
    const body = (req.body ?? {}) as { profileId?: unknown; holder?: unknown };
    if (typeof body.profileId !== "string" || !/^[\w.-]{1,128}$/.test(body.profileId) || typeof body.holder !== "string" || body.holder.length > 256) {
      return reply.code(400).send({
        error: { code: "VALIDATION_FAILED", message: "body must be {profileId, holder}" },
      });
    }
    return { released: store.releaseLease(accountId, body.profileId, body.holder) };
  });

  // Force-release within the caller's own account: evict a stuck lease without being the holder.
  app.delete<{ Params: { profileId: string } }>("/leases/:profileId", async (req, reply) => {
    const accountId = contentAccount(req, reply, true);
    if (!accountId) return;
    if (!store.forceReleaseLease(accountId, req.params.profileId)) return notFound(reply, "no live lease for this profile");
    return { released: req.params.profileId };
  });

  // ---- W2: warmup personas, site settings and plans (account-scoped) ----

  const badRequest = (reply: FastifyReply, message: string) =>
    reply.code(400).send({ error: { code: "VALIDATION_FAILED", message } });

  app.get("/warmup/personas", async (req, reply) => {
    const accountId = contentAccount(req, reply, false);
    if (!accountId) return;
    return { personas: planner.personas(accountId) };
  });

  app.get<{ Params: { id: string } }>("/warmup/personas/:id/sites", async (req, reply) => {
    const accountId = contentAccount(req, reply, false);
    if (!accountId) return;
    return planner.sites(accountId, req.params.id) ?? notFound(reply, "unknown persona");
  });

  app.put<{ Params: { id: string } }>("/warmup/personas/:id/sites", { bodyLimit: 64 * 1024 }, async (req, reply) => {
    const accountId = contentAccount(req, reply, true);
    if (!accountId) return;
    const r = planner.setSites(accountId, req.params.id, req.body);
    if (r === null) return notFound(reply, "unknown persona");
    if ("error" in r) return badRequest(reply, r.error);
    return r;
  });

  /** The concrete visits for one warmup run; nothing else about the persona leaves the server. */
  app.post("/warmup/plan", { bodyLimit: 4096 }, async (req, reply) => {
    const accountId = contentAccount(req, reply, true);
    if (!accountId) return;
    const r = planner.plan(accountId, req.body);
    if ("error" in r) {
      return reply.code(r.status).send({ error: { code: r.status === 404 ? "NOT_FOUND" : "VALIDATION_FAILED", message: r.error } });
    }
    return r;
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
