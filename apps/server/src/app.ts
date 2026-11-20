import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { MAX_BUNDLE_BYTES, type TeamRole, type TeamServerConfig } from "./config.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TeamServerStore } from "./store.js";
import { WarmupPlanner } from "./warmup/service.js";

/**
 * Team server HTTP surface. Design rules:
 * - The server is a durable mailbox for SEALED bundles: payloads are opaque
 *   bytes end to end; there is no decrypt path on this box at all.
 * - Every route except /health requires a bearer key (SHA-256 verified).
 * - LIC (2026-11-19): content (bundles, leases, and W2's warmup plans) is
 *   scoped by ACCOUNT. A licence key belongs to one account and sees only
 *   that account's rows; another account's profile id answers 404, never
 *   403, so ids don't leak. Admin keys belong to no account: they create,
 *   extend, revoke and delete accounts, and every content route refuses
 *   them. An admin never holds a key INTO an account: a new account comes
 *   with a one-time invite, and the tester redeems it (/redeem) for a key
 *   only they see. Expired or revoked accounts authenticate as nobody.
 * - Within an account: viewer reads, operator reads and writes.
 */

interface Auth {
  role: TeamRole;
  name: string;
  /** null for admin keys: they manage accounts and keys, never content. */
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
  close: () => Promise<void>;
}

const PROFILE_ID = /^[\w.-]{1,128}$/;
const MAX_LICENCE_DAYS = 3650;

export function buildTeamServerApp(config: TeamServerConfig): TeamServerApp {
  const store = new TeamServerStore(config.dbPath);
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

  function authenticate(req: FastifyRequest): Auth | { denied: "unknown" | "expired" | "revoked" } {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) return { denied: "unknown" };
    const token = header.slice("Bearer ".length).trim();
    if (!token) return { denied: "unknown" };
    if (config.adminToken && timingSafeStringEqual(token, config.adminToken)) {
      return { role: "admin", name: "env-admin", accountId: null };
    }
    const r = store.authenticate(token);
    return r.ok ? { role: r.role, name: r.name, accountId: r.accountId } : { denied: r.reason };
  }

  /**
   * Liveness probe. Unauthenticated callers get ONLY `{ ok: true }`.
   * An account key sees its own bundle count; an admin key the account count.
   */
  app.get("/health", async (req) => {
    const auth = authenticate(req);
    if ("denied" in auth) return { ok: true };
    if (auth.accountId === null) {
      return { ok: true, name: "queuepilot-team-server", role: auth.role, accounts: store.listAccounts().length };
    }
    return { ok: true, name: "queuepilot-team-server", role: auth.role, bundles: store.listBundles(auth.accountId).length };
  });

  // onRequest (not preHandler): an unauthenticated caller is refused before
  // Fastify reads any body, so nobody can make the server buffer 25 MB uploads
  // without a key (security audit 2026-11-19). /redeem is the one open route
  // with a body; it has its own 4 KB limit.
  app.addHook("onRequest", async (req, reply) => {
    const p = req.url.split("?")[0];
    if (p === "/health" || p === "/health/" || p === "/redeem") return;
    const auth = authenticate(req);
    if ("denied" in auth) {
      const code = auth.denied === "expired" ? "LICENCE_EXPIRED" : auth.denied === "revoked" ? "LICENCE_REVOKED" : "UNAUTHORIZED";
      const message =
        auth.denied === "expired"
          ? "this licence key has expired"
          : auth.denied === "revoked"
            ? "this licence key has been revoked"
            : "missing or invalid bearer token";
      return reply.code(401).send({ error: { code, message } });
    }
    req.teamAuth = auth;
  });

  function requireAdmin(req: FastifyRequest, reply: FastifyReply): boolean {
    if (req.teamAuth.role === "admin") return true;
    reply.code(403).send({ error: { code: "FORBIDDEN", message: "requires an admin key" } });
    return false;
  }

  /**
   * The caller's account for a content route, or null after replying 403.
   * Admin keys have no account and therefore no content access at all.
   */
  function contentAccount(req: FastifyRequest, reply: FastifyReply, write: boolean): string | null {
    const { accountId, role } = req.teamAuth;
    if (accountId === null) {
      reply.code(403).send({
        error: { code: "FORBIDDEN", message: "admin keys manage accounts and keys only; use a licence key for content" },
      });
      return null;
    }
    if (write && role !== "operator") {
      reply.code(403).send({ error: { code: "FORBIDDEN", message: "requires an operator licence key" } });
      return null;
    }
    return accountId;
  }

  const bad = (reply: FastifyReply, message: string) =>
    reply.code(400).send({ error: { code: "VALIDATION_FAILED", message } });
  const notFound = (reply: FastifyReply, message: string) =>
    reply.code(404).send({ error: { code: "NOT_FOUND", message } });

  /** `{days: n}` or `{expiresAt: ISO|null}` → ISO / null; undefined = not given; Error = invalid. */
  function parseExpiry(body: { expiresAt?: unknown; days?: unknown }): string | null | undefined | Error {
    if (body.days !== undefined) {
      if (typeof body.days !== "number" || !Number.isInteger(body.days) || body.days < 1 || body.days > MAX_LICENCE_DAYS) {
        return new Error(`days must be a whole number 1-${MAX_LICENCE_DAYS}`);
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

  function cleanName(v: unknown): string | null {
    return typeof v === "string" && v.trim() && v.trim().length <= 120 ? v.trim() : null;
  }

  // ---- the caller's own licence and keys (account keys) ----

  app.get("/licence", async (req, reply) => {
    const accountId = contentAccount(req, reply, false);
    if (!accountId) return;
    const acct = store.getAccount(accountId);
    if (!acct) return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "account no longer exists" } });
    const msLeft = acct.expiresAt ? Date.parse(acct.expiresAt) - Date.now() : null;
    return {
      account: { id: acct.id, name: acct.name },
      role: req.teamAuth.role,
      expiresAt: acct.expiresAt,
      daysLeft: msLeft === null ? null : Math.max(0, Math.floor(msLeft / 86_400_000)),
    };
  });

  app.get("/licence/keys", async (req, reply) => {
    const accountId = contentAccount(req, reply, false);
    if (!accountId) return;
    return { keys: store.listTokens(accountId) };
  });

  /** An operator adds a key for another of their own machines. Shown once, to them only. */
  app.post("/licence/keys", async (req, reply) => {
    const accountId = contentAccount(req, reply, true);
    if (!accountId) return;
    const body = (req.body ?? {}) as { name?: unknown; role?: unknown };
    const name = cleanName(body.name);
    const role = body.role === undefined ? "operator" : body.role === "operator" || body.role === "viewer" ? body.role : null;
    if (!name || !role) return bad(reply, 'body must be {name: string, role?: "operator"|"viewer"}');
    const { record, token } = store.mintToken(name, role, accountId);
    return reply.code(201).send({ token, ...record });
  });

  app.delete<{ Params: { id: string } }>("/licence/keys/:id", async (req, reply) => {
    const accountId = contentAccount(req, reply, true);
    if (!accountId) return;
    const r = store.deleteAccountToken(accountId, req.params.id);
    if (r === "not-found") return notFound(reply, "key not found");
    if (r === "last-operator") {
      return reply.code(409).send({ error: { code: "LAST_OPERATOR_KEY", message: "this is the account's last operator key; add another first" } });
    }
    return { deleted: req.params.id };
  });

  /**
   * Redeem a one-time invite (no bearer needed): returns the account's first
   * licence key to the tester. The admin who created the invite never sees it.
   */
  app.post("/redeem", { bodyLimit: 4096 }, async (req, reply) => {
    const body = (req.body ?? {}) as { invite?: unknown; name?: unknown };
    const name = cleanName(body.name) ?? "first machine";
    if (typeof body.invite !== "string" || !/^qpi_[\w-]{20,64}$/.test(body.invite)) {
      return bad(reply, "body must be {invite: \"qpi_…\", name?: string}");
    }
    const minted = store.redeemInvite(body.invite, name);
    if (!minted) {
      return reply.code(401).send({ error: { code: "INVITE_INVALID", message: "invite is unknown, used, expired, or the account is not active" } });
    }
    return reply.code(201).send({ token: minted.token, ...minted.record });
  });

  // ---- accounts (admin only; never any content, never a key into an account) ----

  app.get("/accounts", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return { accounts: store.listAccounts() };
  });

  /** Creates an account and its one-time invite code (hand it to the tester). */
  app.post("/accounts", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const body = (req.body ?? {}) as { name?: unknown; expiresAt?: unknown; days?: unknown };
    const name = cleanName(body.name);
    if (!name) return bad(reply, "name must be 1-120 characters");
    const expiry = parseExpiry(body);
    if (expiry instanceof Error) return bad(reply, expiry.message);
    const account = store.createAccount(name, expiry ?? null);
    const invite = store.createInvite(account.id) as { code: string; expiresAt: string };
    return reply.code(201).send({ ...account, invite: invite.code, inviteExpiresAt: invite.expiresAt });
  });

  /**
   * A fresh invite for an account with no keys (the tester lost theirs and
   * the admin deleted the old keys, which stops them working). Refused while
   * the account has any key.
   */
  app.post<{ Params: { id: string } }>("/accounts/:id/invite", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const r = store.createInvite(req.params.id);
    if ("error" in r) {
      return r.error === "unknown"
        ? notFound(reply, "account not found")
        : reply.code(409).send({ error: { code: "ACCOUNT_HAS_KEYS", message: "the account already has keys; delete them first (this stops them working)" } });
    }
    return reply.code(201).send({ invite: r.code, inviteExpiresAt: r.expiresAt });
  });

  app.patch<{ Params: { id: string } }>("/accounts/:id", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const body = (req.body ?? {}) as { name?: unknown; expiresAt?: unknown; days?: unknown; revoked?: unknown };
    const patch: { name?: string; expiresAt?: string | null; revoked?: boolean } = {};
    if (body.name !== undefined) {
      const name = cleanName(body.name);
      if (!name) return bad(reply, "name must be 1-120 characters");
      patch.name = name;
    }
    const expiry = parseExpiry(body);
    if (expiry instanceof Error) return bad(reply, expiry.message);
    if (expiry !== undefined) patch.expiresAt = expiry;
    if (body.revoked !== undefined) {
      if (typeof body.revoked !== "boolean") return bad(reply, "revoked must be true or false");
      patch.revoked = body.revoked;
    }
    const updated = store.updateAccount(req.params.id, patch);
    return updated ?? notFound(reply, "account not found");
  });

  app.delete<{ Params: { id: string } }>("/accounts/:id", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    if (!store.deleteAccount(req.params.id)) return notFound(reply, "account not found");
    return { deleted: req.params.id };
  });

  /** Key metadata (names, last used) — never key material. */
  app.get<{ Params: { id: string } }>("/accounts/:id/keys", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    if (!store.getAccount(req.params.id)) return notFound(reply, "account not found");
    return { keys: store.listTokens(req.params.id) };
  });

  // ---- admin keys + the pre-licence team account ----

  app.get("/tokens", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return { tokens: store.listTokens() };
  });

  /**
   * Mint an admin key, or an operator/viewer key in the pre-licence `team`
   * account (the owner's own data from before licences). Keys for licensed
   * accounts are never minted by an admin: testers get theirs via /redeem.
   */
  app.post("/tokens", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const body = (req.body ?? {}) as { name?: unknown; role?: unknown; accountId?: unknown };
    const name = cleanName(body.name);
    const role = body.role === "operator" || body.role === "viewer" || body.role === "admin" ? body.role : null;
    if (!name || !role) {
      return bad(reply, 'body must be {name: string, role: "admin"|"operator"|"viewer"}');
    }
    if (body.accountId !== undefined) {
      return bad(reply, "admins cannot mint keys into accounts; create the account and give the tester its invite");
    }
    const accountId = role === "admin" ? null : store.ensureLegacyAccount();
    const { record, token } = store.mintToken(name, role, accountId);
    return reply.code(201).send({ token, ...record });
  });

  app.delete<{ Params: { id: string } }>("/tokens/:id", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    if (!store.deleteToken(req.params.id)) return notFound(reply, "token not found");
    return { deleted: req.params.id };
  });

  // ---- bundle mailbox (account-scoped: viewer reads, operator writes) ----

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

  app.put<{ Params: { profileId: string }; Querystring: { baseRevision?: string } }>(
    "/bundles/:profileId",
    async (req, reply) => {
      const accountId = contentAccount(req, reply, true);
      if (!accountId) return;
      const profileId = req.params.profileId;
      if (!PROFILE_ID.test(profileId)) return bad(reply, "profileId must be 1-128 of [A-Za-z0-9_.-]");
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        return bad(reply, "body must be the sealed bundle bytes (application/octet-stream)");
      }
      if (body.length > MAX_BUNDLE_BYTES) {
        return reply.code(413).send({ error: { code: "PAYLOAD_TOO_LARGE", message: `bundle exceeds ${MAX_BUNDLE_BYTES} bytes` } });
      }
      let baseRevision: number | undefined;
      if (req.query.baseRevision !== undefined) {
        const n = Number(req.query.baseRevision);
        if (!Number.isInteger(n) || n < 0) return bad(reply, "baseRevision must be a non-negative integer");
        baseRevision = n;
      }
      const result = store.pushBundle(accountId, profileId, body, req.teamAuth.name, baseRevision);
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

  // ---- per-profile launch leases (account-scoped double-start guard) ----

  app.get("/leases", async (req, reply) => {
    const accountId = contentAccount(req, reply, false);
    if (!accountId) return;
    return { leases: store.listLeases(accountId) };
  });

  app.get<{ Params: { profileId: string } }>("/leases/:profileId", async (req, reply) => {
    const accountId = contentAccount(req, reply, false);
    if (!accountId) return;
    const lease = store.getLease(accountId, req.params.profileId);
    return lease ?? notFound(reply, "no live lease for this profile");
  });

  const ttlOf = (v: unknown) =>
    typeof v === "number" && Number.isInteger(v) ? Math.min(Math.max(v, 5_000), 3_600_000) : 60_000;

  app.post("/leases/acquire", async (req, reply) => {
    const accountId = contentAccount(req, reply, true);
    if (!accountId) return;
    const body = (req.body ?? {}) as { profileId?: unknown; holder?: unknown; machine?: unknown; ttlMs?: unknown };
    const profileId = typeof body.profileId === "string" ? body.profileId : null;
    const holder = typeof body.holder === "string" ? body.holder : null;
    const machine = typeof body.machine === "string" && body.machine ? body.machine : "unknown";
    if (!profileId || !PROFILE_ID.test(profileId) || !holder) {
      return bad(reply, "body must be {profileId, holder, machine?, ttlMs?}");
    }
    const result = store.acquireLease(accountId, profileId, holder, machine, ttlOf(body.ttlMs));
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
    if (typeof body.profileId !== "string" || typeof body.holder !== "string") {
      return bad(reply, "body must be {profileId, holder, ttlMs?}");
    }
    const expiresAt = store.renewLease(accountId, body.profileId, body.holder, ttlOf(body.ttlMs));
    if (!expiresAt) {
      return reply.code(409).send({ error: { code: "LEASE_LOST", message: "lease is gone or held by someone else" } });
    }
    return { profileId: body.profileId, holder: body.holder, expiresAt };
  });

  app.post("/leases/release", async (req, reply) => {
    const accountId = contentAccount(req, reply, true);
    if (!accountId) return;
    const body = (req.body ?? {}) as { profileId?: unknown; holder?: unknown };
    if (typeof body.profileId !== "string" || typeof body.holder !== "string") {
      return bad(reply, "body must be {profileId, holder}");
    }
    return { released: store.releaseLease(accountId, body.profileId, body.holder) };
  });

  // Force-release: evict a stuck lease in your own account without being
  // the holder (a machine died badly). Operator keys only.
  app.delete<{ Params: { profileId: string } }>("/leases/:profileId", async (req, reply) => {
    const accountId = contentAccount(req, reply, true);
    if (!accountId) return;
    if (!store.forceReleaseLease(accountId, req.params.profileId)) return notFound(reply, "no live lease for this profile");
    return { released: req.params.profileId };
  });

  // ---- W2: warmup personas, site settings and plans (account-scoped) ----

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
    if ("error" in r) return bad(reply, r.error);
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
