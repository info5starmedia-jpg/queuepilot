import type { Db } from "../../infrastructure/database.js";
import type {
  ProfileProvider,
  ProxyProvider,
  ProxyDelimiter,
  ProxyDistribution,
} from "@queuepilot/contracts";

interface ProfileProviderRow {
  id: string;
  name: string;
  type: ProfileProvider["type"];
  source_path: string | null;
  sheet_id: string | null;
  sheet_range: string | null;
  last_refreshed_at: string | null;
  created_at: string;
  updated_at: string;
}

function toProfileProvider(r: ProfileProviderRow): ProfileProvider {
  return {
    id: r.id,
    name: r.name,
    type: r.type,
    sourcePath: r.source_path,
    sheetId: r.sheet_id,
    sheetRange: r.sheet_range,
    lastRefreshedAt: r.last_refreshed_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class ProfileProviderRepository {
  constructor(private readonly db: Db) {}

  create(p: ProfileProvider): void {
    this.db
      .prepare(
        `INSERT INTO profile_providers (id, name, type, source_path, sheet_id, sheet_range, last_refreshed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        p.id,
        p.name,
        p.type,
        p.sourcePath,
        p.sheetId,
        p.sheetRange,
        p.lastRefreshedAt,
        p.createdAt,
        p.updatedAt,
      );
  }

  get(id: string): ProfileProvider | null {
    const r = this.db
      .prepare("SELECT * FROM profile_providers WHERE id = ?")
      .get(id) as ProfileProviderRow | undefined;
    return r ? toProfileProvider(r) : null;
  }

  list(): ProfileProvider[] {
    return (
      this.db
        .prepare("SELECT * FROM profile_providers ORDER BY created_at DESC")
        .all() as ProfileProviderRow[]
    ).map(toProfileProvider);
  }

  update(p: ProfileProvider): void {
    this.db
      .prepare(
        "UPDATE profile_providers SET name=?, source_path=?, sheet_id=?, sheet_range=?, last_refreshed_at=?, updated_at=? WHERE id=?",
      )
      .run(
        p.name,
        p.sourcePath,
        p.sheetId,
        p.sheetRange,
        p.lastRefreshedAt,
        p.updatedAt,
        p.id,
      );
  }

  delete(id: string): void {
    this.db.prepare("DELETE FROM profile_providers WHERE id = ?").run(id);
  }
}

interface ProxyProviderRow {
  id: string;
  name: string;
  type: ProxyProvider["type"];
  source_path: string | null;
  sheet_id: string | null;
  sheet_range: string | null;
  delimiter: string;
  has_header: number;
  distribution: string;
  cursor: number;
  last_refreshed_at: string | null;
  created_at: string;
  updated_at: string;
}

function toProxyProvider(r: ProxyProviderRow): ProxyProvider {
  return {
    id: r.id,
    name: r.name,
    type: r.type,
    sourcePath: r.source_path,
    sheetId: r.sheet_id,
    sheetRange: r.sheet_range,
    delimiter: r.delimiter as ProxyDelimiter,
    hasHeader: r.has_header === 1,
    distribution: r.distribution as ProxyDistribution,
    cursor: r.cursor,
    lastRefreshedAt: r.last_refreshed_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class ProxyProviderRepository {
  constructor(private readonly db: Db) {}

  create(p: ProxyProvider): void {
    this.db
      .prepare(
        `INSERT INTO proxy_providers (id, name, type, source_path, sheet_id, sheet_range, delimiter, has_header, distribution, cursor, last_refreshed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        p.id,
        p.name,
        p.type,
        p.sourcePath,
        p.sheetId,
        p.sheetRange,
        p.delimiter,
        p.hasHeader ? 1 : 0,
        p.distribution,
        p.cursor,
        p.lastRefreshedAt,
        p.createdAt,
        p.updatedAt,
      );
  }

  get(id: string): ProxyProvider | null {
    const r = this.db
      .prepare("SELECT * FROM proxy_providers WHERE id = ?")
      .get(id) as ProxyProviderRow | undefined;
    return r ? toProxyProvider(r) : null;
  }

  list(): ProxyProvider[] {
    return (
      this.db
        .prepare("SELECT * FROM proxy_providers ORDER BY created_at DESC")
        .all() as ProxyProviderRow[]
    ).map(toProxyProvider);
  }

  update(p: ProxyProvider): void {
    this.db
      .prepare(
        "UPDATE proxy_providers SET name=?, source_path=?, sheet_id=?, sheet_range=?, delimiter=?, has_header=?, distribution=?, cursor=?, last_refreshed_at=?, updated_at=? WHERE id=?",
      )
      .run(
        p.name,
        p.sourcePath,
        p.sheetId,
        p.sheetRange,
        p.delimiter,
        p.hasHeader ? 1 : 0,
        p.distribution,
        p.cursor,
        p.lastRefreshedAt,
        p.updatedAt,
        p.id,
      );
  }

  delete(id: string): void {
    this.db.prepare("DELETE FROM proxy_providers WHERE id = ?").run(id);
  }
}
