import Database from "better-sqlite3";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { TeamRole } from "./config.js";

/**
 * TeamServerStore — bundles + token hashes. Same persistence discipline as
 * the API (better-sqlite3, WAL, one transaction per mutation): the server
 * is a dumb, durable mailbox for sealed bundles, nothing more.
 *
 * Tokens: only SHA-256 hashes are stored. A mint returns the plaintext once;
 * after that it exists only on the client machine that minted it. The env
 * bootstrap admin token is compared against config directly and is never
 * written to the database.
 */

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
}

interface TokenRow {
  id: string;
  name: string;
  token_hash: string;
  role: TeamRole;
  created_at: string;
  last_used_at: string | null;
}

interface BundleRow {
  profile_id: string;
  payload: string; // base64 — sealed bundle bytes are binary-safe here
  revision: number;
  updated_by: string;
  updated_at: string;
}

export class TeamServerStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bundles (
        profile_id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        revision INTEGER NOT NULL,
        updated_by TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tokens (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL CHECK (role IN ('admin','operator','viewer')),
        created_at TEXT NOT NULL,
        last_used_at TEXT
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  static hashToken(token: string): string {
    return createHash("sha256").update(token, "utf8").digest("hex");
  }

  /** Returns the authenticated role, or null. `lastUsedAt` stamps on hit. */
  authenticate(token: string): { role: TeamRole; name: string } | null {
    const hash = TeamServerStore.hashToken(token);
    const row = this.db.prepare("SELECT * FROM tokens WHERE token_hash = ?").get(hash) as
      | TokenRow
      | undefined;
    if (!row) return null;
    this.db
      .prepare("UPDATE tokens SET last_used_at = ? WHERE id = ?")
      .run(new Date().toISOString(), row.id);
    return { role: row.role, name: row.name };
  }

  mintToken(name: string, role: TeamRole): { record: TokenRecord; token: string } {
    const token = `qpt_${randomBytes(24).toString("base64url")}`;
    const now = new Date().toISOString();
    const record: TokenRecord = {
      id: randomBytes(8).toString("hex"),
      name,
      role,
      createdAt: now,
      lastUsedAt: null,
    };
    this.db
      .prepare(
        "INSERT INTO tokens (id, name, token_hash, role, created_at, last_used_at) VALUES (?,?,?,?,?,?)",
      )
      .run(record.id, name, TeamServerStore.hashToken(token), role, now, null);
    return { record, token };
  }

  listTokens(): TokenRecord[] {
    return (
      this.db
        .prepare("SELECT id, name, role, created_at, last_used_at FROM tokens ORDER BY created_at")
        .all() as TokenRow[]
    ).map((r) => ({
      id: r.id,
      name: r.name,
      role: r.role,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
    }));
  }

  deleteToken(id: string): boolean {
    return this.db.prepare("DELETE FROM tokens WHERE id = ?").run(id).changes > 0;
  }

  /** True when the stored hash for `id` matches `token` (constant time). */
  tokenMatches(id: string, token: string): boolean {
    const row = this.db.prepare("SELECT token_hash FROM tokens WHERE id = ?").get(id) as
      | { token_hash: string }
      | undefined;
    if (!row) return false;
    const a = Buffer.from(row.token_hash, "utf8");
    const b = Buffer.from(TeamServerStore.hashToken(token), "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /**
   * Push sealed bundle bytes. `baseRevision` gives optimistic concurrency:
   * when supplied, the stored revision must match or the push is rejected
   * (409 REVISION_CONFLICT) — two machines editing one profile can never
   * silently overwrite each other. First push (no stored bundle) requires
   * baseRevision absent or 0.
   */
  pushBundle(
    profileId: string,
    payload: Buffer,
    updatedBy: string,
    baseRevision?: number,
  ): { revision: number } | { conflict: number } {
    const tx = this.db.transaction((): { revision: number } | { conflict: number } => {
      const existing = this.getRow(profileId);
      if (existing) {
        if (baseRevision === undefined || baseRevision !== existing.revision) {
          return { conflict: existing.revision };
        }
        const revision = existing.revision + 1;
        this.db
          .prepare(
            "UPDATE bundles SET payload=?, revision=?, updated_by=?, updated_at=? WHERE profile_id=?",
          )
          .run(payload.toString("base64"), revision, updatedBy, new Date().toISOString(), profileId);
        return { revision };
      }
      if (baseRevision !== undefined && baseRevision !== 0) {
        return { conflict: 0 };
      }
      this.db
        .prepare(
          "INSERT INTO bundles (profile_id, payload, revision, updated_by, updated_at) VALUES (?,?,?,?,?)",
        )
        .run(profileId, payload.toString("base64"), 1, updatedBy, new Date().toISOString());
      return { revision: 1 };
    });
    return tx();
  }

  pullBundle(profileId: string): { payload: Buffer; head: BundleHead } | null {
    const row = this.getRow(profileId);
    if (!row) return null;
    return {
      payload: Buffer.from(row.payload, "base64"),
      head: {
        profileId: row.profile_id,
        revision: row.revision,
        updatedBy: row.updated_by,
        updatedAt: row.updated_at,
        size: Buffer.from(row.payload, "base64").length,
      },
    };
  }

  listBundles(): BundleHead[] {
    return (
      this.db
        .prepare("SELECT profile_id, revision, updated_by, updated_at, payload FROM bundles ORDER BY profile_id")
        .all() as BundleRow[]
    ).map((r) => ({
      profileId: r.profile_id,
      revision: r.revision,
      updatedBy: r.updated_by,
      updatedAt: r.updated_at,
      size: Buffer.from(r.payload, "base64").length,
    }));
  }

  deleteBundle(profileId: string): boolean {
    return this.db.prepare("DELETE FROM bundles WHERE profile_id = ?").run(profileId).changes > 0;
  }

  private getRow(profileId: string): BundleRow | undefined {
    return this.db.prepare("SELECT * FROM bundles WHERE profile_id = ?").get(profileId) as
      | BundleRow
      | undefined;
  }
}
