import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

/**
 * Persistence: a single SQLite file, WAL mode, explicit migrations.
 *
 * better-sqlite3 is synchronous — deliberate (ADR-0002). Profile operations
 * are microsecond-scale; a sync driver removes an entire class of
 * async-ordering bugs from the lifecycle code, and every mutation that guards
 * a browser launch stays inside one transaction.
 */
export type Db = Database.Database;

interface Migration {
  id: string;
  up: string;
}

const MIGRATIONS: Migration[] = [
  {
    id: "001-init",
    up: `
      CREATE TABLE profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        grp TEXT NOT NULL DEFAULT 'default',
        proxy_id TEXT REFERENCES proxies(id) ON DELETE SET NULL,
        identity_id TEXT REFERENCES fingerprint_identities(id) ON DELETE SET NULL,
        status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle','running','error')),
        notes TEXT NOT NULL DEFAULT '',
        tags TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE proxies (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('http','https','socks5')),
        host TEXT NOT NULL,
        port INTEGER NOT NULL,
        username TEXT,
        password TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE fingerprint_identities (
        id TEXT PRIMARY KEY,
        seed INTEGER NOT NULL,
        platform TEXT NOT NULL CHECK (platform IN ('windows','macos','linux')),
        screen_width INTEGER NOT NULL,
        screen_height INTEGER NOT NULL,
        hardware_concurrency INTEGER NOT NULL,
        device_memory_gb INTEGER NOT NULL,
        timezone TEXT NOT NULL,
        locale TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE browser_runs (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN ('launching','running','stopped','crashed')),
        pid INTEGER,
        debug_port INTEGER,
        ws_endpoint TEXT,
        started_at TEXT NOT NULL,
        stopped_at TEXT,
        last_error TEXT
      );
      -- The double-launch guard at the storage layer: at most ONE occupying
      -- run per profile, enforced by SQLite itself, not by our code alone.
      CREATE UNIQUE INDEX one_occupying_run_per_profile
        ON browser_runs(profile_id)
        WHERE status IN ('launching','running');
    `,
  },
  {
    id: "002-providers",
    up: `
      ALTER TABLE profiles ADD COLUMN provider_id TEXT;
      ALTER TABLE profiles ADD COLUMN provider_key TEXT;
      ALTER TABLE profiles ADD COLUMN email TEXT;
      ALTER TABLE profiles ADD COLUMN extra TEXT NOT NULL DEFAULT '{}';
      -- One row per (provider, Profile-column key): refresh upserts on this.
      CREATE UNIQUE INDEX provider_profile_key
        ON profiles(provider_id, provider_key)
        WHERE provider_id IS NOT NULL;

      ALTER TABLE proxies ADD COLUMN timezone TEXT;
      ALTER TABLE proxies ADD COLUMN provider_id TEXT;

      CREATE TABLE profile_providers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('csv')),
        source_path TEXT NOT NULL,
        last_refreshed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE proxy_providers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('file')),
        source_path TEXT NOT NULL,
        delimiter TEXT NOT NULL DEFAULT ',',
        has_header INTEGER NOT NULL DEFAULT 0,
        distribution TEXT NOT NULL DEFAULT 'start-over'
          CHECK (distribution IN ('persist','start-over','random')),
        cursor INTEGER NOT NULL DEFAULT 0,
        last_refreshed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    id: "003-google-sheet-providers",
    up: `
      -- SQLite cannot widen a CHECK constraint; rebuild both provider tables
      -- with the new source type and sheet columns, preserving all rows.
      CREATE TABLE profile_providers_new (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('csv','googleSheet')),
        source_path TEXT,
        sheet_id TEXT,
        sheet_range TEXT,
        last_refreshed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO profile_providers_new
        (id, name, type, source_path, sheet_id, sheet_range, last_refreshed_at, created_at, updated_at)
        SELECT id, name, type, source_path, NULL, NULL, last_refreshed_at, created_at, updated_at
        FROM profile_providers;
      DROP TABLE profile_providers;
      ALTER TABLE profile_providers_new RENAME TO profile_providers;

      CREATE TABLE proxy_providers_new (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('file','googleSheet')),
        source_path TEXT,
        sheet_id TEXT,
        sheet_range TEXT,
        delimiter TEXT NOT NULL DEFAULT ',',
        has_header INTEGER NOT NULL DEFAULT 0,
        distribution TEXT NOT NULL DEFAULT 'start-over'
          CHECK (distribution IN ('persist','start-over','random')),
        cursor INTEGER NOT NULL DEFAULT 0,
        last_refreshed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO proxy_providers_new
        (id, name, type, source_path, sheet_id, sheet_range, delimiter, has_header, distribution, cursor, last_refreshed_at, created_at, updated_at)
        SELECT id, name, type, source_path, NULL, NULL, delimiter, has_header, distribution, cursor, last_refreshed_at, created_at, updated_at
        FROM proxy_providers;
      DROP TABLE proxy_providers;
      ALTER TABLE proxy_providers_new RENAME TO proxy_providers;
    `,
  },
];

export function openDatabase(dbPath: string): Db {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

export function migrate(db: Db): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  const applied = new Set(
    (
      db.prepare("SELECT id FROM schema_migrations").all() as { id: string }[]
    ).map((r) => r.id),
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    db.transaction(() => {
      db.exec(m.up);
      db.prepare(
        "INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)",
      ).run(m.id, new Date().toISOString());
    })();
  }
}

/** Test helper: in-memory database with migrations applied. */
export function openTestDatabase(): Db {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}
