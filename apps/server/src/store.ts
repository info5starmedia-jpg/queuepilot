import Database from "better-sqlite3";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { TeamRole } from "./config.js";

/**
 * TeamServerStore — accounts, licence keys (token hashes), sealed bundles and
 * launch leases. better-sqlite3, WAL, one transaction per mutation.
 *
 * LIC (2026-11-19): every piece of content belongs to an ACCOUNT. Bundles
 * and leases are keyed (account_id, profile_id), and every content method
 * takes the caller's accountId, so one account can never name another's
 * rows — the isolation lives here, not only in the routes.
 *
 * Keys: only SHA-256 hashes are stored; a mint returns the plaintext once.
 * Account keys (operator / viewer) carry the account's licence expiry —
 * an expired or revoked account authenticates as nobody. Admin keys belong
 * to no account: they manage accounts and keys and have no content path.
 */

/** The account pre-licence data (bundles, leases, non-admin tokens) migrates into. */
export const LEGACY_ACCOUNT_ID = "team";

export interface AccountRecord {
  id: string;
  name: string;
  createdAt: string;
  /** Licence expiry (ISO); null = no expiry. */
  expiresAt: string | null;
  revokedAt: string | null;
}

export interface TokenRecord {
  id: string;
  name: string;
  role: TeamRole;
  /** null for admin keys. */
  accountId: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface BundleHead {
  profileId: string;
  revision: number;
  updatedBy: string;
  updatedAt: string;
  size: number;
}

/**
 * One per-profile launch lease (P7.7b). The holder is `hostname:pid` of the
 * API process that started the profile; the lease prevents a SECOND machine
 * of the same account from starting that profile while the first one's
 * browser is up. Leases carry an expiry and decay on their own.
 */
export interface LeaseRecord {
  profileId: string;
  holder: string;
  machine: string;
  acquiredAt: string;
  expiresAt: string;
}

export type AuthResult =
  | { ok: true; role: TeamRole; name: string; accountId: string | null }
  | { ok: false; reason: "unknown" | "expired" | "revoked" };

interface TokenRow {
  id: string;
  name: string;
  token_hash: string;
  role: TeamRole;
  account_id: string | null;
  created_at: string;
  last_used_at: string | null;
}

interface AccountRow {
  id: string;
  name: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
}

interface BundleRow {
  account_id: string;
  profile_id: string;
  payload: string; // base64 — sealed bundle bytes are binary-safe here
  revision: number;
  updated_by: string;
  updated_at: string;
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

function toAccount(r: AccountRow): AccountRecord {
  return { id: r.id, name: r.name, createdAt: r.created_at, expiresAt: r.expires_at, revokedAt: r.revoked_at };
}

export class TeamServerStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS warmup_sites (
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        persona_id TEXT NOT NULL,
        settings TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (account_id, persona_id)
      );
      CREATE TABLE IF NOT EXISTS invites (
        code_hash TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
    `);
  }

  /**
   * Schema v2 (LIC). A v0/v1 database (profile_id primary keys, tokens
   * without accounts) is rebuilt in one transaction: its bundles, leases and
   * non-admin tokens move into the LEGACY_ACCOUNT_ID account, so an existing
   * team keeps working; admin tokens stay account-less.
   */
  private migrate(): void {
    const version = this.db.pragma("user_version", { simple: true }) as number;
    if (version >= 2) return;
    const hasTable = (t: string) =>
      !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
    const hasColumn = (t: string, c: string) =>
      (this.db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).some((x) => x.name === c);

    this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS accounts (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT,
          revoked_at TEXT
        );
      `);
      const legacy = (hasTable("bundles") && !hasColumn("bundles", "account_id")) ||
        (hasTable("leases") && !hasColumn("leases", "account_id")) ||
        (hasTable("tokens") && !hasColumn("tokens", "account_id"));
      if (legacy) {
        this.db
          .prepare("INSERT OR IGNORE INTO accounts (id, name, created_at, expires_at, revoked_at) VALUES (?,?,?,NULL,NULL)")
          .run(LEGACY_ACCOUNT_ID, "Team (before licences)", new Date().toISOString());
      }
      if (hasTable("bundles") && !hasColumn("bundles", "account_id")) this.db.exec("ALTER TABLE bundles RENAME TO bundles_v1");
      if (hasTable("leases") && !hasColumn("leases", "account_id")) this.db.exec("ALTER TABLE leases RENAME TO leases_v1");
      if (hasTable("tokens") && !hasColumn("tokens", "account_id")) this.db.exec("ALTER TABLE tokens RENAME TO tokens_v1");

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS tokens (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          token_hash TEXT NOT NULL UNIQUE,
          role TEXT NOT NULL CHECK (role IN ('admin','operator','viewer')),
          account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
          created_at TEXT NOT NULL,
          last_used_at TEXT,
          CHECK ((role = 'admin') = (account_id IS NULL))
        );
        CREATE TABLE IF NOT EXISTS bundles (
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          profile_id TEXT NOT NULL,
          payload TEXT NOT NULL,
          revision INTEGER NOT NULL,
          updated_by TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (account_id, profile_id)
        );
        CREATE TABLE IF NOT EXISTS leases (
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          profile_id TEXT NOT NULL,
          holder TEXT NOT NULL,
          machine TEXT NOT NULL,
          acquired_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          PRIMARY KEY (account_id, profile_id)
        );
      `);
      if (hasTable("tokens_v1")) {
        this.db.exec(`
          INSERT INTO tokens (id, name, token_hash, role, account_id, created_at, last_used_at)
            SELECT id, name, token_hash, role, CASE role WHEN 'admin' THEN NULL ELSE '${LEGACY_ACCOUNT_ID}' END, created_at, last_used_at FROM tokens_v1;
          DROP TABLE tokens_v1;`);
      }
      if (hasTable("bundles_v1")) {
        this.db.exec(`
          INSERT INTO bundles (account_id, profile_id, payload, revision, updated_by, updated_at)
            SELECT '${LEGACY_ACCOUNT_ID}', profile_id, payload, revision, updated_by, updated_at FROM bundles_v1;
          DROP TABLE bundles_v1;`);
      }
      if (hasTable("leases_v1")) {
        this.db.exec(`
          INSERT INTO leases (account_id, profile_id, holder, machine, acquired_at, expires_at)
            SELECT '${LEGACY_ACCOUNT_ID}', profile_id, holder, machine, acquired_at, expires_at FROM leases_v1;
          DROP TABLE leases_v1;`);
      }
      this.db.pragma("user_version = 2");
    })();
  }

  close(): void {
    this.db.close();
  }

  static hashToken(token: string): string {
    return createHash("sha256").update(token, "utf8").digest("hex");
  }

  // ---- authentication: the single chokepoint for expiry / revocation ----

  authenticate(token: string, now = Date.now()): AuthResult {
    const hash = TeamServerStore.hashToken(token);
    const row = this.db.prepare("SELECT * FROM tokens WHERE token_hash = ?").get(hash) as TokenRow | undefined;
    if (!row) return { ok: false, reason: "unknown" };
    if (row.account_id !== null) {
      const acct = this.getAccountRow(row.account_id);
      if (!acct) return { ok: false, reason: "unknown" };
      if (acct.revoked_at) return { ok: false, reason: "revoked" };
      if (acct.expires_at && Date.parse(acct.expires_at) <= now) return { ok: false, reason: "expired" };
    } else if (row.role !== "admin") {
      return { ok: false, reason: "unknown" }; // defence in depth; the CHECK forbids it
    }
    this.db.prepare("UPDATE tokens SET last_used_at = ? WHERE id = ?").run(new Date(now).toISOString(), row.id);
    return { ok: true, role: row.role, name: row.name, accountId: row.account_id };
  }

  // ---- accounts (admin) ----

  createAccount(name: string, expiresAt: string | null): AccountRecord {
    const rec: AccountRecord = {
      id: `acct_${randomBytes(8).toString("hex")}`,
      name,
      createdAt: new Date().toISOString(),
      expiresAt,
      revokedAt: null,
    };
    this.db
      .prepare("INSERT INTO accounts (id, name, created_at, expires_at, revoked_at) VALUES (?,?,?,?,NULL)")
      .run(rec.id, rec.name, rec.createdAt, rec.expiresAt);
    return rec;
  }

  /** The pre-licence team account, created on first use; returns its id. */
  ensureLegacyAccount(): string {
    this.db
      .prepare("INSERT OR IGNORE INTO accounts (id, name, created_at, expires_at, revoked_at) VALUES (?,?,?,NULL,NULL)")
      .run(LEGACY_ACCOUNT_ID, "Team (before licences)", new Date().toISOString());
    return LEGACY_ACCOUNT_ID;
  }

  getAccount(id: string): AccountRecord | null {
    const r = this.getAccountRow(id);
    return r ? toAccount(r) : null;
  }

  listAccounts(): AccountRecord[] {
    return (this.db.prepare("SELECT * FROM accounts ORDER BY created_at").all() as AccountRow[]).map(toAccount);
  }

  /** Extend / shorten the licence, revoke or un-revoke. Returns null for an unknown account. */
  updateAccount(id: string, patch: { name?: string; expiresAt?: string | null; revoked?: boolean }): AccountRecord | null {
    const cur = this.getAccountRow(id);
    if (!cur) return null;
    const next: AccountRow = {
      ...cur,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.expiresAt !== undefined ? { expires_at: patch.expiresAt } : {}),
      ...(patch.revoked !== undefined ? { revoked_at: patch.revoked ? (cur.revoked_at ?? new Date().toISOString()) : null } : {}),
    };
    this.db
      .prepare("UPDATE accounts SET name=?, expires_at=?, revoked_at=? WHERE id=?")
      .run(next.name, next.expires_at, next.revoked_at, id);
    return toAccount(next);
  }

  // ---- invites: how a tester gets a key the admin never sees ----

  /**
   * One-time invite for an account that has NO keys yet. The admin hands the
   * code to the tester; redeeming it mints the account's first key, shown
   * only to the redeemer. An account that already has keys gets no invite,
   * so the admin can only re-enter by deleting every key first — which the
   * tester notices at once (their keys stop working).
   */
  createInvite(accountId: string, ttlMs = 7 * 86_400_000): { code: string; expiresAt: string } | { error: "unknown" | "has-keys" } {
    if (!this.getAccountRow(accountId)) return { error: "unknown" };
    if (this.listTokens(accountId).length > 0) return { error: "has-keys" };
    const code = `qpi_${randomBytes(24).toString("base64url")}`;
    const now = Date.now();
    const expiresAt = new Date(now + ttlMs).toISOString();
    this.db.transaction(() => {
      // An invite opens a CLEAN account: whatever the account held before
      // (a re-invite after its keys were deleted) is wiped in the same
      // transaction, so an invite can never be a way into someone's data.
      this.wipeAccountContent(accountId);
      this.db.prepare("DELETE FROM invites WHERE account_id = ?").run(accountId); // one live invite per account
      this.db
        .prepare("INSERT INTO invites (code_hash, account_id, created_at, expires_at) VALUES (?,?,?,?)")
        .run(TeamServerStore.hashToken(code), accountId, new Date(now).toISOString(), expiresAt);
    })();
    return { code, expiresAt };
  }

  /** Redeem an invite: single use, expiring, and only while the account still has no keys. */
  redeemInvite(code: string, keyName: string): { record: TokenRecord; token: string } | null {
    const hash = TeamServerStore.hashToken(code);
    return this.db.transaction(() => {
      const inv = this.db.prepare("SELECT * FROM invites WHERE code_hash = ?").get(hash) as
        | { account_id: string; expires_at: string }
        | undefined;
      if (!inv) return null;
      this.db.prepare("DELETE FROM invites WHERE code_hash = ?").run(hash);
      if (Date.parse(inv.expires_at) <= Date.now()) return null;
      const acct = this.getAccountRow(inv.account_id);
      if (!acct || acct.revoked_at || (acct.expires_at && Date.parse(acct.expires_at) <= Date.now())) return null;
      if (this.listTokens(inv.account_id).length > 0) return null;
      return this.mintToken(keyName, "operator", inv.account_id);
    })();
  }

  /**
   * Every account-scoped content table. New content tables (W2 warmup
   * settings…) MUST be added here so a re-invite wipes them too.
   */
  static readonly CONTENT_TABLES = ["bundles", "leases", "warmup_sites"];

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

  private wipeAccountContent(accountId: string): void {
    for (const t of TeamServerStore.CONTENT_TABLES) {
      this.db.prepare(`DELETE FROM ${t} WHERE account_id = ?`).run(accountId);
    }
  }

  /**
   * Delete one key of an account (scoped: a key id from another account is a
   * no-op). The last operator key cannot be deleted this way, so an account
   * holder never leaves their account open to a re-invite by accident.
   */
  deleteAccountToken(accountId: string, id: string): "deleted" | "not-found" | "last-operator" {
    return this.db.transaction(() => {
      const row = this.db.prepare("SELECT role FROM tokens WHERE id = ? AND account_id = ?").get(id, accountId) as
        | { role: TeamRole }
        | undefined;
      if (!row) return "not-found" as const;
      if (row.role === "operator") {
        const ops = this.db.prepare("SELECT COUNT(*) AS n FROM tokens WHERE account_id = ? AND role = 'operator'").get(accountId) as { n: number };
        if (ops.n <= 1) return "last-operator" as const;
      }
      this.db.prepare("DELETE FROM tokens WHERE id = ?").run(id);
      return "deleted" as const;
    })();
  }

  /** Deletes the account, its keys and its sealed server data (cascade). */
  deleteAccount(id: string): boolean {
    return this.db.prepare("DELETE FROM accounts WHERE id = ?").run(id).changes > 0;
  }

  // ---- keys ----

  /**
   * Admin keys: accountId null. Account keys: operator / viewer bound to an
   * existing account. The plaintext is returned once.
   */
  mintToken(name: string, role: TeamRole, accountId: string | null = null): { record: TokenRecord; token: string } {
    if ((role === "admin") !== (accountId === null)) {
      throw new Error("admin keys have no account; operator/viewer keys need one");
    }
    const token = `${role === "admin" ? "qpt" : "qpl"}_${randomBytes(24).toString("base64url")}`;
    const now = new Date().toISOString();
    const record: TokenRecord = { id: randomBytes(8).toString("hex"), name, role, accountId, createdAt: now, lastUsedAt: null };
    this.db
      .prepare("INSERT INTO tokens (id, name, token_hash, role, account_id, created_at, last_used_at) VALUES (?,?,?,?,?,?,?)")
      .run(record.id, name, TeamServerStore.hashToken(token), role, accountId, now, null);
    return { record, token };
  }

  listTokens(accountId?: string): TokenRecord[] {
    const rows = (accountId === undefined
      ? this.db.prepare("SELECT * FROM tokens ORDER BY created_at").all()
      : this.db.prepare("SELECT * FROM tokens WHERE account_id = ? ORDER BY created_at").all(accountId)) as TokenRow[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      role: r.role,
      accountId: r.account_id,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
    }));
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
   * (409 REVISION_CONFLICT). First push requires baseRevision absent or 0.
   */
  pushBundle(
    accountId: string,
    profileId: string,
    payload: Buffer,
    updatedBy: string,
    baseRevision?: number,
  ): { revision: number } | { conflict: number } {
    const tx = this.db.transaction((): { revision: number } | { conflict: number } => {
      const existing = this.getRow(accountId, profileId);
      const now = new Date().toISOString();
      if (existing) {
        if (baseRevision === undefined || baseRevision !== existing.revision) return { conflict: existing.revision };
        const revision = existing.revision + 1;
        this.db
          .prepare("UPDATE bundles SET payload=?, revision=?, updated_by=?, updated_at=? WHERE account_id=? AND profile_id=?")
          .run(payload.toString("base64"), revision, updatedBy, now, accountId, profileId);
        return { revision };
      }
      if (baseRevision !== undefined && baseRevision !== 0) return { conflict: 0 };
      this.db
        .prepare("INSERT INTO bundles (account_id, profile_id, payload, revision, updated_by, updated_at) VALUES (?,?,?,?,?,?)")
        .run(accountId, profileId, payload.toString("base64"), 1, updatedBy, now);
      return { revision: 1 };
    });
    return tx();
  }

  pullBundle(accountId: string, profileId: string): { payload: Buffer; head: BundleHead } | null {
    const row = this.getRow(accountId, profileId);
    if (!row) return null;
    const payload = Buffer.from(row.payload, "base64");
    return {
      payload,
      head: { profileId: row.profile_id, revision: row.revision, updatedBy: row.updated_by, updatedAt: row.updated_at, size: payload.length },
    };
  }

  listBundles(accountId: string): BundleHead[] {
    return (
      this.db
        .prepare("SELECT * FROM bundles WHERE account_id = ? ORDER BY profile_id")
        .all(accountId) as BundleRow[]
    ).map((r) => ({
      profileId: r.profile_id,
      revision: r.revision,
      updatedBy: r.updated_by,
      updatedAt: r.updated_at,
      size: Buffer.from(r.payload, "base64").length,
    }));
  }

  deleteBundle(accountId: string, profileId: string): boolean {
    return this.db.prepare("DELETE FROM bundles WHERE account_id = ? AND profile_id = ?").run(accountId, profileId).changes > 0;
  }

  // ---- per-profile launch leases (account-scoped) ----

  /**
   * Acquire the launch lease. Fails (LEASE_HELD) when a DIFFERENT holder in
   * the same account holds an unexpired lease; an expired lease is taken over.
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
    return this.db
      .prepare("DELETE FROM leases WHERE account_id = ? AND profile_id = ? AND holder = ?")
      .run(accountId, profileId, holder).changes > 0;
  }

  /** Force-release within the account: the "that machine died badly" path. */
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

  /** Every live lease of the account (expired rows reaped first). */
  listLeases(accountId: string): LeaseRecord[] {
    this.db.prepare("DELETE FROM leases WHERE expires_at <= ?").run(new Date().toISOString());
    return (this.db.prepare("SELECT * FROM leases WHERE account_id = ? ORDER BY profile_id").all(accountId) as LeaseRow[]).map(toLease);
  }

  private getAccountRow(id: string): AccountRow | undefined {
    return this.db.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as AccountRow | undefined;
  }

  private getLeaseRow(accountId: string, profileId: string): LeaseRow | undefined {
    return this.db.prepare("SELECT * FROM leases WHERE account_id = ? AND profile_id = ?").get(accountId, profileId) as LeaseRow | undefined;
  }

  private getRow(accountId: string, profileId: string): BundleRow | undefined {
    return this.db.prepare("SELECT * FROM bundles WHERE account_id = ? AND profile_id = ?").get(accountId, profileId) as BundleRow | undefined;
  }
}
