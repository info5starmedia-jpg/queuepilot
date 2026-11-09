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
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class ProfileRepository {
  constructor(private readonly db: Db) {}

  create(p: Profile): void {
    this.db
      .prepare(
        `INSERT INTO profiles (id, name, grp, proxy_id, identity_id, status, notes, tags, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(p.id, p.name, p.group, p.proxyId, p.identityId, p.status, p.notes, JSON.stringify(p.tags), p.createdAt, p.updatedAt);
  }

  get(id: string): Profile | null {
    const row = this.db.prepare("SELECT * FROM profiles WHERE id = ?").get(id) as
      | ProfileRow
      | undefined;
    return row ? toProfile(row) : null;
  }

  list(filter: { group?: string; query?: string } = {}): Profile[] {
    let sql = "SELECT * FROM profiles";
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
    if (where.length) sql += " WHERE " + where.join(" AND ");
    sql += " ORDER BY created_at DESC";
    return (this.db.prepare(sql).all(...args) as ProfileRow[]).map(toProfile);
  }

  update(p: Profile): void {
    this.db
      .prepare(
        `UPDATE profiles SET name=?, grp=?, proxy_id=?, identity_id=?, status=?, notes=?, tags=?, updated_at=? WHERE id=?`,
      )
      .run(p.name, p.group, p.proxyId, p.identityId, p.status, p.notes, JSON.stringify(p.tags), p.updatedAt, p.id);
  }

  delete(id: string): void {
    this.db.prepare("DELETE FROM profiles WHERE id = ?").run(id);
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
