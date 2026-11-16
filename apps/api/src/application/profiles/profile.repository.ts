import type { Db } from "../../infrastructure/database.js";
import type { Profile, FingerprintIdentity } from "@queuepilot/contracts";

/** Row shapes as stored; repositories own the SQL <-> contract mapping. */
interface ProfileRow {
  id: string;
  name: string;
  grp: string;
  proxy_id: string | null;
  identity_id: string | null;
  status: Profile["status"];
  notes: string;
  tags: string;
  provider_id: string | null;
  provider_key: string | null;
  email: string | null;
  extra: string;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

function toProfile(r: ProfileRow): Profile {
  return {
    id: r.id,
    name: r.name,
    group: r.grp,
    proxyId: r.proxy_id,
    identityId: r.identity_id,
    status: r.status,
    notes: r.notes,
    tags: JSON.parse(r.tags) as string[],
    email: r.email ?? null,
    providerId: r.provider_id ?? null,
    providerKey: r.provider_key ?? null,
    extra: JSON.parse(r.extra ?? "{}") as Record<string, unknown>,
    deletedAt: r.deleted_at ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class ProfileRepository {
  constructor(private readonly db: Db) {}

  create(p: Profile): void {
    this.db
      .prepare(
        `INSERT INTO profiles (id, name, grp, proxy_id, identity_id, status, notes, tags, provider_id, provider_key, email, extra, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(p.id, p.name, p.group, p.proxyId, p.identityId, p.status, p.notes, JSON.stringify(p.tags), p.providerId, p.providerKey, p.email, JSON.stringify(p.extra), p.createdAt, p.updatedAt);
  }

  get(id: string): Profile | null {
    const row = this.db.prepare("SELECT * FROM profiles WHERE id = ? AND deleted_at IS NULL").get(id) as
      | ProfileRow
      | undefined;
    return row ? toProfile(row) : null;
  }

  /** The trashed row, if any (restore/purge operate on these). */
  getTrashed(id: string): Profile | null {
    const row = this.db.prepare("SELECT * FROM profiles WHERE id = ? AND deleted_at IS NOT NULL").get(id) as
      | ProfileRow
      | undefined;
    return row ? toProfile(row) : null;
  }

  list(filter: { group?: string; query?: string } = {}): Profile[] {
    let sql = "SELECT * FROM profiles WHERE deleted_at IS NULL";
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter.group) {
      where.push("grp = ?");
      args.push(filter.group);
    }
    if (filter.query) {
      where.push("name LIKE ?");
      args.push(`%${filter.query}%`);
    }
    if (where.length) sql += " AND " + where.join(" AND ");
    sql += " ORDER BY created_at DESC";
    return (this.db.prepare(sql).all(...args) as ProfileRow[]).map(toProfile);
  }

  /** Folder-tab aggregates: every group with its total + running counts. */
  groups(): { group: string; total: number; running: number }[] {
    return (
      this.db
        .prepare(
          `SELECT grp AS "group",
                  COUNT(*) AS total,
                  SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running
           FROM profiles WHERE deleted_at IS NULL GROUP BY grp ORDER BY grp ASC`,
        )
        .all() as { group: string; total: number; running: number }[]
    );
  }

  /**
   * Live-row update. Deliberately does NOT touch deleted_at: editing a
   * trashed profile keeps it trashed until an explicit restore.
   */
  update(p: Profile): void {
    this.db
      .prepare(
        `UPDATE profiles SET name=?, grp=?, proxy_id=?, identity_id=?, status=?, notes=?, tags=?, provider_id=?, provider_key=?, email=?, extra=?, updated_at=? WHERE id=?`,
      )
      .run(p.name, p.group, p.proxyId, p.identityId, p.status, p.notes, JSON.stringify(p.tags), p.providerId, p.providerKey, p.email, JSON.stringify(p.extra), p.updatedAt, p.id);
  }

  delete(id: string): void {
    this.db.prepare("DELETE FROM profiles WHERE id = ?").run(id);
  }

  /** Soft delete: hide the profile from every live query until restored. */
  trash(id: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE profiles SET deleted_at = ?, updated_at = ? WHERE id = ?")
      .run(now, now, id);
  }

  /** Bring a trashed profile back to the live lists. */
  restore(id: string): void {
    this.db
      .prepare("UPDATE profiles SET deleted_at = NULL, updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
  }

  /** Everything in the trash, newest-discarded first. */
  listTrashed(): Profile[] {
    return (
      this.db
        .prepare("SELECT * FROM profiles WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC")
        .all() as ProfileRow[]
    ).map(toProfile);
  }

  /** The profile a provider row maps to, if it was imported before. */
  getByProviderKey(providerId: string, providerKey: string): Profile | null {
    const row = this.db
      .prepare("SELECT * FROM profiles WHERE provider_id = ? AND provider_key = ? AND deleted_at IS NULL")
      .get(providerId, providerKey) as ProfileRow | undefined;
    return row ? toProfile(row) : null;
  }

  /**
   * Rename a group across every profile (v0.14.17 console group actions).
   * Returns how many profiles moved; 0 means the source group doesn't exist.
   */
  renameGroup(from: string, to: string): number {
    return this.db.prepare("UPDATE profiles SET grp = ?, updated_at = ? WHERE grp = ?").run(
      to,
      new Date().toISOString(),
      from,
    ).changes;
  }

  /** True when any profile already carries this group name. */
  groupExists(name: string): boolean {
    const row = this.db.prepare("SELECT 1 AS x FROM profiles WHERE grp = ? LIMIT 1").get(name);
    return row !== undefined;
  }

  /** Detach all profiles from a provider (used when the provider is deleted). */
  detachProvider(providerId: string): void {
    this.db
      .prepare("UPDATE profiles SET provider_id = NULL, provider_key = NULL WHERE provider_id = ?")
      .run(providerId);
  }
}

interface IdentityRow {
  id: string;
  seed: number;
  platform: FingerprintIdentity["platform"];
  screen_width: number;
  screen_height: number;
  hardware_concurrency: number;
  device_memory_gb: FingerprintIdentity["deviceMemoryGb"];
  timezone: string;
  locale: string;
  created_at: string;
}

export class FingerprintIdentityRepository {
  constructor(private readonly db: Db) {}

  create(i: FingerprintIdentity): void {
    this.db
      .prepare(
        `INSERT INTO fingerprint_identities (id, seed, platform, screen_width, screen_height, hardware_concurrency, device_memory_gb, timezone, locale, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(i.id, i.seed, i.platform, i.screenWidth, i.screenHeight, i.hardwareConcurrency, i.deviceMemoryGb, i.timezone, i.locale, i.createdAt);
  }

  get(id: string): FingerprintIdentity | null {
    const r = this.db.prepare("SELECT * FROM fingerprint_identities WHERE id = ?").get(id) as
      | IdentityRow
      | undefined;
    if (!r) return null;
    return {
      id: r.id,
      seed: r.seed,
      platform: r.platform,
      screenWidth: r.screen_width,
      screenHeight: r.screen_height,
      hardwareConcurrency: r.hardware_concurrency,
      deviceMemoryGb: r.device_memory_gb,
      timezone: r.timezone,
      locale: r.locale,
      createdAt: r.created_at,
    };
  }
}
