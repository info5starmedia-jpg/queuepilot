import Database from "better-sqlite3";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { TeamRole } from "./config.js";

/**
 * TeamServerStore — sealed bundles, launch leases, warmup site settings and
 * device-token hashes. Same persistence discipline as the API (better-sqlite3,
 * WAL, one transaction per mutation): the server is a durable mailbox for
 * sealed bundles, nothing more.
 *
 * Account isolation (owner decision 2026-11-20): every content row is keyed
 * by `account_id` — the id of a human account in AuthStore's `accounts`
 * table. Each account is a private island: every content method takes the
 * caller's accountId and only ever touches that account's rows, so another
 * account's profile id is simply not found (404), never 403.
 *
 * Tokens: only SHA-256 hashes are stored. A mint returns the plaintext once.
 * Device tokens are the owner's machines: a non-admin device token belongs to
 * the owner's account; an admin device token belongs to no account (it
 * manages accounts and never reads content). The env bootstrap admin token is
 * compared against config directly and is never written to the database.
 */

/**
 * Content that predates any owner account (a pre-hosted team server) is
 * parked under this id until /auth/bootstrap creates the owner, which adopts
 * it (adoptPendingContent). It is never a real account id.
 */
export const PENDING_OWNER_ID = "owner-pending";

export interface TokenRecord {
  id: string;
  name: string;
  role: TeamRole;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface BundleHead {
  profileId: string;
  revision: number;
  updatedBy: string;
  updatedAt: string;
  size: number;
  /**
   * Optional client-supplied JSON metadata ({name, tags, ...}). The server
   * never interprets it — it exists so the dashboard can LIST profiles by
   * name without downloading sealed payloads. Max 4 KiB.
   */
  meta: string | null;
}

/**
 * One per-profile launch lease (P7.7b). The holder is `hostname:pid` of the
 * API process that started the profile; the lease prevents a SECOND machine
 * from starting the same profile while the first one's browser is up.
 * Leases are coordination, not durable locks: they carry an expiry, the
 * holder renews while the profile runs, and a crashed holder's lease decays
 * on its own.
 */
export interface LeaseRecord {
  profileId: string;
  holder: string;
  machine: string;
  acquiredAt: string;
  expiresAt: string;
}

interface TokenRow {
  id: string;
  name: string;
  token_hash: string;
  role: TeamRole;
  account_id: string | null;
  created_at: string;
  last_used_at: string | null;
}

interface BundleRow {
  account_id: string;
  profile_id: string;
  payload: string; // base64 — sealed bundle bytes are binary-safe here
  revision: number;
  updated_by: string;
  updated_at: string;
  meta: string | null;
}

interface LeaseRow {
  account_id: string;
  profile_id: string;
  holder: string;
  machine: string;
  acquired_at: string;
  expires_at: string;
}

function toLease(r: LeaseRow): LeaseRecord {
  return {
    profileId: r.profile_id,
    holder: r.holder,
    machine: r.machine,
    acquiredAt: r.acquired_at,
    expiresAt: r.expires_at,
  };
}

/** Every account-scoped content table (deleteAccountContent / adoptPendingContent walk these). */
const CONTENT_TABLES = ["bundles", "leases", "warmup_sites"] as const;

export class TeamServerStore {
  private readonly db: Database.Database;
  private readonly ownsConnection: boolean;

  /**
   * Accepts a path (owns the connection, applies WAL pragma) or an existing
   * better-sqlite3 connection (shared with AuthStore so both see the same
   * database — required for ":memory:" test databases, where two connections
   * would be two distinct databases). Construct AuthStore first on a shared
   * connection so the migration can find the owner account.
   */
  constructor(dbOrPath: string | Database.Database) {
    if (typeof dbOrPath === "string") {
      this.ownsConnection = true;
      this.db = new Database(dbOrPath);
      this.db.pragma("journal_mode = WAL");
    } else {
      this.ownsConnection = false;
      this.db = dbOrPath;
    }
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  close(): void {
    if (this.ownsConnection) this.db.close();
  }

  // ---- schema + the account-isolation migration ----

  private hasTable(t: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
  }

  private hasColumn(t: string, c: string): boolean {
    return (this.db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).some((x) => x.name === c);
  }

  /** The owner's account id, or PENDING_OWNER_ID when no owner exists yet. */
  ownerAccountId(): string {
    if (!this.hasTable("accounts") || !this.hasColumn("accounts", "tier")) return PENDING_OWNER_ID;
    const r = this.db.prepare("SELECT id FROM accounts WHERE tier = 'owner' LIMIT 1").get() as { id: string } | undefined;
    return r?.id ?? PENDING_OWNER_ID;
  }

  /**
   * Idempotent, one transaction. A fresh database gets the account-scoped
   * shape directly. A pre-isolation database (the live hosted server: bundles
   * and leases keyed by profile_id alone, tokens without an account) is
   * rebuilt so every existing row lands in the OWNER's account — the owner's
   * data stays his, and his sign-in (sessions/accounts, untouched) keeps
   * working. Admin device tokens stay account-less.
   */
  private migrate(): void {
    this.db.transaction(() => {
      const owner = this.ownerAccountId();

      // bundles — older hosted DBs may still lack `meta`; add it before copying.
      if (this.hasTable("bundles") && !this.hasColumn("bundles", "account_id")) {
        if (!this.hasColumn("bundles", "meta")) this.db.exec("ALTER TABLE bundles ADD COLUMN meta TEXT");
        this.db.exec("ALTER TABLE bundles RENAME TO bundles_v1");
      }
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS bundles (
          account_id TEXT NOT NULL,
          profile_id TEXT NOT NULL,
          payload TEXT NOT NULL,
          revision INTEGER NOT NULL,
          updated_by TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          meta TEXT,
          PRIMARY KEY (account_id, profile_id)
        );
      `);
      if (this.hasTable("bundles_v1")) {
        this.db
          .prepare(
            `INSERT INTO bundles (account_id, profile_id, payload, revision, updated_by, updated_at, meta)
               SELECT ?, profile_id, payload, revision, updated_by, updated_at, meta FROM bundles_v1`,
          )
          .run(owner);
        this.db.exec("DROP TABLE bundles_v1");
      }

      // leases
      if (this.hasTable("leases") && !this.hasColumn("leases", "account_id")) {
        this.db.exec("ALTER TABLE leases RENAME TO leases_v1");
      }
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS leases (
          account_id TEXT NOT NULL,
          profile_id TEXT NOT NULL,
          holder TEXT NOT NULL,
          machine TEXT NOT NULL,
          acquired_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          PRIMARY KEY (account_id, profile_id)
        );
      `);
      if (this.hasTable("leases_v1")) {
        this.db
          .prepare(
            `INSERT INTO leases (account_id, profile_id, holder, machine, acquired_at, expires_at)
               SELECT ?, profile_id, holder, machine, acquired_at, expires_at FROM leases_v1`,
          )
          .run(owner);
        this.db.exec("DROP TABLE leases_v1");
      }

      // tokens — non-admin device tokens are the owner's machines.
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS tokens (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          token_hash TEXT NOT NULL UNIQUE,
          role TEXT NOT NULL CHECK (role IN ('admin','operator','viewer')),
          account_id TEXT,
          created_at TEXT NOT NULL,
          last_used_at TEXT
        );
      `);
      if (!this.hasColumn("tokens", "account_id")) {
        this.db.exec("ALTER TABLE tokens ADD COLUMN account_id TEXT");
        this.db.prepare("UPDATE tokens SET account_id = ? WHERE role != 'admin'").run(owner);
      }

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS warmup_sites (
          account_id TEXT NOT NULL,
          persona_id TEXT NOT NULL,
          settings TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (account_id, persona_id)
        );
      `);

      // Self-healing (audit L2): once an owner exists, anything still parked
      // under PENDING_OWNER_ID is his — on every startup, not only at bootstrap.
      // OR IGNORE: a parked row whose id the owner already has stays parked
      // (never deleted, never a startup failure).
      if (owner !== PENDING_OWNER_ID) {
        for (const t of CONTENT_TABLES) {
          this.db.prepare(`UPDATE OR IGNORE ${t} SET account_id = ? WHERE account_id = ?`).run(owner, PENDING_OWNER_ID);
        }
        this.db.prepare("UPDATE tokens SET account_id = ? WHERE account_id = ?").run(owner, PENDING_OWNER_ID);
      }
    })();
  }

  /**
   * /auth/bootstrap just created the owner: content parked under
   * PENDING_OWNER_ID (from a pre-hosted server) becomes the owner's.
   */
  adoptPendingContent(ownerId: string): void {
    this.db.transaction(() => {
      for (const t of CONTENT_TABLES) {
        this.db.prepare(`UPDATE OR IGNORE ${t} SET account_id = ? WHERE account_id = ?`).run(ownerId, PENDING_OWNER_ID);
      }
      this.db.prepare("UPDATE tokens SET account_id = ? WHERE account_id = ?").run(ownerId, PENDING_OWNER_ID);
    })();
  }

  /** A deleted account's island goes with it: bundles, leases, warmup settings, device tokens. */
  deleteAccountContent(accountId: string): void {
    this.db.transaction(() => {
      for (const t of CONTENT_TABLES) this.db.prepare(`DELETE FROM ${t} WHERE account_id = ?`).run(accountId);
      this.db.prepare("DELETE FROM tokens WHERE account_id = ?").run(accountId);
    })();
  }

  // ---- device tokens ----

  static hashToken(token: string): string {
    return createHash("sha256").update(token, "utf8").digest("hex");
  }

  /** The token's role, name and account (null for admin tokens), or null. `lastUsedAt` stamps on hit. */
  authenticate(token: string): { role: TeamRole; name: string; accountId: string | null } | null {
    const hash = TeamServerStore.hashToken(token);
    const row = this.db.prepare("SELECT * FROM tokens WHERE token_hash = ?").get(hash) as TokenRow | undefined;
    if (!row) return null;
    this.db.prepare("UPDATE tokens SET last_used_at = ? WHERE id = ?").run(new Date().toISOString(), row.id);
    return { role: row.role, name: row.name, accountId: row.role === "admin" ? null : row.account_id };
  }

  /** Admin tokens belong to no account; every other device token must name one. */
  mintToken(name: string, role: TeamRole, accountId: string | null): { record: TokenRecord; token: string } {
    if ((role === "admin") !== (accountId === null)) {
      throw new Error("admin device tokens have no account; operator/viewer tokens need one");
    }
    const token = `qpt_${randomBytes(24).toString("base64url")}`;
    const now = new Date().toISOString();
    const record: TokenRecord = { id: randomBytes(8).toString("hex"), name, role, createdAt: now, lastUsedAt: null };
    this.db
      .prepare("INSERT INTO tokens (id, name, token_hash, role, account_id, created_at, last_used_at) VALUES (?,?,?,?,?,?,?)")
      .run(record.id, name, TeamServerStore.hashToken(token), role, accountId, now, null);
    return { record, token };
  }

  listTokens(): TokenRecord[] {
    return (
      this.db.prepare("SELECT id, name, role, created_at, last_used_at FROM tokens ORDER BY created_at").all() as TokenRow[]
    ).map((r) => ({ id: r.id, name: r.name, role: r.role, createdAt: r.created_at, lastUsedAt: r.last_used_at }));
  }

  deleteToken(id: string): boolean {
    return this.db.prepare("DELETE FROM tokens WHERE id = ?").run(id).changes > 0;
  }

  /** True when the stored hash for `id` matches `token` (constant time). */
  tokenMatches(id: string, token: string): boolean {
    const row = this.db.prepare("SELECT token_hash FROM tokens WHERE id = ?").get(id) as { token_hash: string } | undefined;
    if (!row) return false;
    const a = Buffer.from(row.token_hash, "utf8");
    const b = Buffer.from(TeamServerStore.hashToken(token), "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
  }

  // ---- bundles (account-scoped) ----

  /**
   * Push sealed bundle bytes. `baseRevision` gives optimistic concurrency:
   * when supplied, the stored revision must match or the push is rejected
   * (409 REVISION_CONFLICT) — two machines editing one profile can never
   * silently overwrite each other. First push (no stored bundle) requires
   * baseRevision absent or 0.
   */
  pushBundle(
    accountId: string,
    profileId: string,
    payload: Buffer,
    updatedBy: string,
    baseRevision?: number,
    meta?: string,
  ): { revision: number } | { conflict: number } {
    const tx = this.db.transaction((): { revision: number } | { conflict: number } => {
      const existing = this.getRow(accountId, profileId);
      const now = new Date().toISOString();
      if (existing) {
        if (baseRevision === undefined || baseRevision !== existing.revision) return { conflict: existing.revision };
        const revision = existing.revision + 1;
        this.db
          .prepare("UPDATE bundles SET payload=?, revision=?, updated_by=?, updated_at=?, meta=? WHERE account_id=? AND profile_id=?")
          .run(payload.toString("base64"), revision, updatedBy, now, meta ?? existing.meta, accountId, profileId);
        return { revision };
      }
      if (baseRevision !== undefined && baseRevision !== 0) return { conflict: 0 };
      this.db
        .prepare("INSERT INTO bundles (account_id, profile_id, payload, revision, updated_by, updated_at, meta) VALUES (?,?,?,?,?,?,?)")
        .run(accountId, profileId, payload.toString("base64"), 1, updatedBy, now, meta ?? null);
      return { revision: 1 };
    });
    return tx();
  }

  pullBundle(accountId: string, profileId: string): { payload: Buffer; head: BundleHead } | null {
    const row = this.getRow(accountId, profileId);
    if (!row) return null;
    return { payload: Buffer.from(row.payload, "base64"), head: this.headFromRow(row) };
  }

  private headFromRow(r: BundleRow): BundleHead {
    return {
      profileId: r.profile_id,
      revision: r.revision,
      updatedBy: r.updated_by,
      updatedAt: r.updated_at,
      size: Buffer.from(r.payload, "base64").length,
      meta: r.meta,
    };
  }

  listBundles(accountId: string): BundleHead[] {
    return (
      this.db.prepare("SELECT * FROM bundles WHERE account_id = ? ORDER BY profile_id").all(accountId) as BundleRow[]
    ).map((r) => this.headFromRow(r));
  }

  deleteBundle(accountId: string, profileId: string): boolean {
    return this.db.prepare("DELETE FROM bundles WHERE account_id = ? AND profile_id = ?").run(accountId, profileId).changes > 0;
  }

  // ---- per-profile launch leases (P7.7b), account-scoped ----

  /**
   * Acquire the launch lease for a profile. Fails (LEASE_HELD) when a
   * DIFFERENT holder holds a lease that has not expired; an expired lease is
   * taken over unconditionally — that is the crashed-holder cleanup path.
   */
  acquireLease(
    accountId: string,
    profileId: string,
    holder: string,
    machine: string,
    ttlMs: number,
  ): { acquired: true; expiresAt: string } | { acquired: false; heldBy: string; expiresAt: string } {
    const now = Date.now();
    const expiresAt = new Date(now + ttlMs).toISOString();
    const tx = this.db.transaction(() => {
      const row = this.getLeaseRow(accountId, profileId);
      if (row && Date.parse(row.expires_at) > now && row.holder !== holder) {
        return { acquired: false as const, heldBy: row.holder, expiresAt: row.expires_at };
      }
      this.db
        .prepare(
          `INSERT INTO leases (account_id, profile_id, holder, machine, acquired_at, expires_at) VALUES (?,?,?,?,?,?)
           ON CONFLICT(account_id, profile_id) DO UPDATE SET
             holder = excluded.holder, machine = excluded.machine,
             acquired_at = excluded.acquired_at, expires_at = excluded.expires_at`,
        )
        .run(accountId, profileId, holder, machine, new Date(now).toISOString(), expiresAt);
      return { acquired: true as const, expiresAt };
    });
    return tx();
  }

  /** Renew a lease the same holder owns; null when unowned or taken over. */
  renewLease(accountId: string, profileId: string, holder: string, ttlMs: number): string | null {
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    const r = this.db
      .prepare("UPDATE leases SET expires_at = ? WHERE account_id = ? AND profile_id = ? AND holder = ?")
      .run(expiresAt, accountId, profileId, holder);
    return r.changes > 0 ? expiresAt : null;
  }

  /** Release only when the caller is the holder (a stranger's release is a no-op). */
  releaseLease(accountId: string, profileId: string, holder: string): boolean {
    return (
      this.db.prepare("DELETE FROM leases WHERE account_id = ? AND profile_id = ? AND holder = ?").run(accountId, profileId, holder)
        .changes > 0
    );
  }

  /**
   * Force-release (P5, v0.16.0): evict a stuck lease in the caller's own
   * account regardless of holder — the "that machine died badly" path.
   */
  forceReleaseLease(accountId: string, profileId: string): boolean {
    return this.db.prepare("DELETE FROM leases WHERE account_id = ? AND profile_id = ?").run(accountId, profileId).changes > 0;
  }

  /** The live lease, or null. Expired rows are reaped on read. */
  getLease(accountId: string, profileId: string): LeaseRecord | null {
    const row = this.getLeaseRow(accountId, profileId);
    if (!row) return null;
    if (Date.parse(row.expires_at) <= Date.now()) {
      this.db.prepare("DELETE FROM leases WHERE account_id = ? AND profile_id = ?").run(accountId, profileId);
      return null;
    }
    return toLease(row);
  }

  /** Every live lease in the account (expired rows reaped first). */
  listLeases(accountId: string): LeaseRecord[] {
    // Reap only this account's expired rows: a read never writes another account's (audit L6).
    this.db.prepare("DELETE FROM leases WHERE account_id = ? AND expires_at <= ?").run(accountId, new Date().toISOString());
    return (
      this.db.prepare("SELECT * FROM leases WHERE account_id = ? ORDER BY profile_id").all(accountId) as LeaseRow[]
    ).map(toLease);
  }

  // ---- W2: per-account warmup site settings ----

  getSiteSettings(accountId: string, personaId: string): unknown | null {
    const r = this.db.prepare("SELECT settings FROM warmup_sites WHERE account_id = ? AND persona_id = ?").get(accountId, personaId) as
      | { settings: string }
      | undefined;
    if (!r) return null;
    try {
      return JSON.parse(r.settings) as unknown;
    } catch {
      return null;
    }
  }

  setSiteSettings(accountId: string, personaId: string, json: string): void {
    this.db
      .prepare(
        `INSERT INTO warmup_sites (account_id, persona_id, settings, updated_at) VALUES (?,?,?,?)
         ON CONFLICT(account_id, persona_id) DO UPDATE SET settings = excluded.settings, updated_at = excluded.updated_at`,
      )
      .run(accountId, personaId, json, new Date().toISOString());
  }

  private getLeaseRow(accountId: string, profileId: string): LeaseRow | undefined {
    return this.db.prepare("SELECT * FROM leases WHERE account_id = ? AND profile_id = ?").get(accountId, profileId) as
      | LeaseRow
      | undefined;
  }

  private getRow(accountId: string, profileId: string): BundleRow | undefined {
    return this.db.prepare("SELECT * FROM bundles WHERE account_id = ? AND profile_id = ?").get(accountId, profileId) as
      | BundleRow
      | undefined;
  }
}
