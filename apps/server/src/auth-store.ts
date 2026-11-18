import Database from "better-sqlite3";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { hash as argon2Hash, verify as argon2Verify } from "@node-rs/argon2";

/**
 * AuthStore — accounts, invites, sessions for the hosted team deployment
 * (owner-directed 2026-11-17). Layers on top of the device-token system
 * (store.ts) without touching it: desktop machines keep working with their
 * minted bearer tokens, and humans sign in with email + password.
 *
 * Discipline matches the rest of the server:
 * - Passwords: Argon2id (memory-hard; the OWASP-recommended first choice).
 *   The hash string embeds salt + params — verify() parses it, no side data.
 * - Sessions: only SHA-256 hashes stored; the plaintext token is shown once
 *   at signin. 30-day expiry, sliding (lastSeenAt stamps on use).
 * - Invites: only the code HASH is stored; the plaintext code is shown once
 *   to the owner, handed to the teammate out of band.
 */

export type AccountTier = "owner" | "L3" | "L2" | "L1";

export const TEAM_MEMBER_CAP = 10;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface AccountRecord {
  id: string;
  email: string;
  displayName: string;
  tier: AccountTier;
  active: boolean;
  createdAt: string;
}

export interface InviteRecord {
  id: string;
  role: AccountTier;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  usedByEmail: string | null;
}

interface AccountRow {
  id: string;
  email: string;
  password_hash: string;
  display_name: string;
  tier: AccountTier;
  active: number;
  created_at: string;
}

interface InviteRow {
  id: string;
  code_hash: string;
  role: AccountTier;
  created_by: string;
  created_at: string;
  expires_at: string;
  used_at: string | null;
  used_by_email: string | null;
}

interface SessionRow {
  id: string;
  token_hash: string;
  account_id: string;
  created_at: string;
  expires_at: string;
  last_seen_at: string;
}

function toAccount(r: AccountRow): AccountRecord {
  return {
    id: r.id,
    email: r.email,
    displayName: r.display_name,
    tier: r.tier,
    active: r.active === 1,
    createdAt: r.created_at,
  };
}

function toInvite(r: InviteRow): InviteRecord {
  return {
    id: r.id,
    role: r.role,
    createdBy: r.created_by,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    usedAt: r.used_at,
    usedByEmail: r.used_by_email,
  };
}

export class AuthStore {
  private readonly db: Database.Database;
  private readonly ownsConnection: boolean;

  /** Same contract as TeamServerStore: path (owns it) or shared connection. */
  constructor(dbOrPath: string | Database.Database) {
    if (typeof dbOrPath === "string") {
      this.ownsConnection = true;
      this.db = new Database(dbOrPath);
      this.db.pragma("journal_mode = WAL");
    } else {
      this.ownsConnection = false;
      this.db = dbOrPath;
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        display_name TEXT NOT NULL,
        tier TEXT NOT NULL CHECK (tier IN ('owner','L3','L2','L1')),
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS invites (
        id TEXT PRIMARY KEY,
        code_hash TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL CHECK (role IN ('L3','L2','L1')),
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        used_by_email TEXT
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        account_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );
    `);
  }

  close(): void {
    if (this.ownsConnection) this.db.close();
  }

  static hashSecret(secret: string): string {
    return createHash("sha256").update(secret, "utf8").digest("hex");
  }

  // ---- accounts ----

  memberCount(): number {
    return (
      this.db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE active = 1").get() as { n: number }
    ).n;
  }

  hasOwner(): boolean {
    return !!this.db.prepare("SELECT 1 FROM accounts WHERE tier = 'owner' LIMIT 1").get();
  }

  async createAccount(
    email: string,
    password: string,
    displayName: string,
    tier: AccountTier,
  ): Promise<AccountRecord> {
    const id = randomBytes(8).toString("hex");
    const passwordHash = await argon2Hash(password);
    this.db
      .prepare(
        "INSERT INTO accounts (id, email, password_hash, display_name, tier, active, created_at) VALUES (?,?,?,?,?,1,?)",
      )
      .run(id, email, passwordHash, displayName, tier, new Date().toISOString());
    return this.getAccount(id)!;
  }

  getAccount(id: string): AccountRecord | null {
    const row = this.db.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as
      | AccountRow
      | undefined;
    return row ? toAccount(row) : null;
  }

  getAccountByEmail(email: string): AccountRecord | null {
    const row = this.db.prepare("SELECT * FROM accounts WHERE email = ?").get(email) as
      | AccountRow
      | undefined;
    return row ? toAccount(row) : null;
  }

  listAccounts(): AccountRecord[] {
    return (this.db.prepare("SELECT * FROM accounts ORDER BY created_at").all() as AccountRow[]).map(
      toAccount,
    );
  }

  setAccountActive(id: string, active: boolean): boolean {
    return (
      this.db.prepare("UPDATE accounts SET active = ? WHERE id = ?").run(active ? 1 : 0, id)
        .changes > 0
    );
  }

  setAccountTier(id: string, tier: AccountTier): boolean {
    if (tier === "owner") {
      // Exactly one owner, always. Re-tiering someone else to owner is an
      // ownership transfer, which this route deliberately does not do.
      return false;
    }
    return this.db.prepare("UPDATE accounts SET tier = ? WHERE id = ?").run(tier, id).changes > 0;
  }

  deleteAccount(id: string): boolean {
    const acc = this.getAccount(id);
    if (!acc || acc.tier === "owner") return false; // the owner account is never deletable
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM sessions WHERE account_id = ?").run(id);
      this.db.prepare("DELETE FROM accounts WHERE id = ?").run(id);
    });
    tx();
    return true;
  }

  async verifyPassword(email: string, password: string): Promise<AccountRecord | null> {
    const row = this.db.prepare("SELECT * FROM accounts WHERE email = ?").get(email) as
      | AccountRow
      | undefined;
    if (!row || row.active !== 1) return null;
    const ok = await argon2Verify(row.password_hash, password).catch(() => false);
    return ok ? toAccount(row) : null;
  }

  // ---- sessions ----

  createSession(accountId: string): { token: string; expiresAt: string } {
    const token = `qps_${randomBytes(32).toString("base64url")}`;
    const now = Date.now();
    const expiresAt = new Date(now + SESSION_TTL_MS).toISOString();
    this.db
      .prepare(
        "INSERT INTO sessions (id, token_hash, account_id, created_at, expires_at, last_seen_at) VALUES (?,?,?,?,?,?)",
      )
      .run(
        randomBytes(8).toString("hex"),
        AuthStore.hashSecret(token),
        accountId,
        new Date(now).toISOString(),
        expiresAt,
        new Date(now).toISOString(),
      );
    return { token, expiresAt };
  }

  /** Resolve a session token to its account; expired sessions are reaped + rejected. */
  authenticateSession(token: string): AccountRecord | null {
    const hash = AuthStore.hashSecret(token);
    const row = this.db.prepare("SELECT * FROM sessions WHERE token_hash = ?").get(hash) as
      | SessionRow
      | undefined;
    if (!row) return null;
    const now = Date.now();
    if (Date.parse(row.expires_at) <= now || !timingSafeEqual(Buffer.from(hash), Buffer.from(row.token_hash))) {
      this.db.prepare("DELETE FROM sessions WHERE id = ?").run(row.id);
      return null;
    }
    this.db
      .prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?")
      .run(new Date(now).toISOString(), row.id);
    const account = this.getAccount(row.account_id);
    return account && account.active ? account : null;
  }

  deleteSession(token: string): boolean {
    return (
      this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(AuthStore.hashSecret(token))
        .changes > 0
    );
  }

  // ---- invites ----

  /** Owner mints an invite; the plaintext code is returned exactly once. */
  createInvite(role: AccountTier, createdBy: string): { record: InviteRecord; code: string } {
    const code = `qpi_${randomBytes(16).toString("base64url")}`;
    const id = randomBytes(8).toString("hex");
    const now = Date.now();
    this.db
      .prepare(
        "INSERT INTO invites (id, code_hash, role, created_by, created_at, expires_at) VALUES (?,?,?,?,?,?)",
      )
      .run(
        id,
        AuthStore.hashSecret(code),
        role,
        createdBy,
        new Date(now).toISOString(),
        new Date(now + INVITE_TTL_MS).toISOString(),
      );
    return { record: this.getInvite(id)!, code };
  }

  getInvite(id: string): InviteRecord | null {
    const row = this.db.prepare("SELECT * FROM invites WHERE id = ?").get(id) as
      | InviteRow
      | undefined;
    return row ? toInvite(row) : null;
  }

  listInvites(): InviteRecord[] {
    return (this.db.prepare("SELECT * FROM invites ORDER BY created_at").all() as InviteRow[]).map(
      toInvite,
    );
  }

  revokeInvite(id: string): boolean {
    return this.db.prepare("DELETE FROM invites WHERE id = ?").run(id).changes > 0;
  }

  /**
   * Consume an invite code → the role it grants, or null when invalid,
   * expired, or already used. Atomic UPDATE-first so double-redeem races
   * both fail.
   */
  redeemInvite(code: string, email: string): { role: AccountTier } | null {
    const hash = AuthStore.hashSecret(code);
    const tx = this.db.transaction((): { role: AccountTier } | null => {
      const row = this.db.prepare("SELECT * FROM invites WHERE code_hash = ?").get(hash) as
        | InviteRow
        | undefined;
      if (!row) return null;
      if (row.used_at !== null) return null;
      if (Date.parse(row.expires_at) <= Date.now()) return null;
      const r = this.db
        .prepare("UPDATE invites SET used_at = ?, used_by_email = ? WHERE id = ? AND used_at IS NULL")
        .run(new Date().toISOString(), email, row.id);
      return r.changes > 0 ? { role: row.role } : null;
    });
    return tx();
  }
}
