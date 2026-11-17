import type { Db } from "../../infrastructure/database.js";
import type { Proxy } from "@queuepilot/contracts";
import type { ProxyGeo } from "./proxy-probe.js";

/** Stored row includes the password; the public contract never does. */
export interface StoredProxy extends Proxy {
  password: string | null;
}

interface ProxyRow {
  id: string;
  name: string;
  type: Proxy["type"];
  host: string;
  port: number;
  username: string | null;
  password: string | null;
  timezone: string | null;
  provider_id: string | null;
  grp: string;
  created_at: string;
  updated_at: string;
}

export interface ProxyGroupSummary {
  group: string;
  total: number;
  /** Proxies in the group attached to at least one live profile. */
  inUse: number;
}

function toStored(r: ProxyRow): StoredProxy {
  return {
    id: r.id,
    name: r.name,
    type: r.type,
    host: r.host,
    port: r.port,
    username: r.username,
    password: r.password,
    timezone: r.timezone ?? null,
    providerId: r.provider_id ?? null,
    group: r.grp ?? "default",
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Strip the password before anything leaves the process. */
export function publicProxy(p: StoredProxy): Proxy {
  const { password: _password, ...rest } = p;
  return rest;
}

export class ProxyRepository {
  constructor(private readonly db: Db) {}

  create(p: StoredProxy): void {
    this.db
      .prepare(
        `INSERT INTO proxies (id, name, type, host, port, username, password, timezone, provider_id, grp, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(p.id, p.name, p.type, p.host, p.port, p.username, p.password, p.timezone, p.providerId, p.group ?? "default", p.createdAt, p.updatedAt);
  }

  get(id: string): StoredProxy | null {
    const r = this.db.prepare("SELECT * FROM proxies WHERE id = ?").get(id) as ProxyRow | undefined;
    return r ? toStored(r) : null;
  }

  /** Newest first; `group` narrows to one folder. */
  list(group?: string): StoredProxy[] {
    const rows =
      group === undefined
        ? this.db.prepare("SELECT * FROM proxies ORDER BY created_at DESC").all()
        : this.db.prepare("SELECT * FROM proxies WHERE grp = ? ORDER BY created_at DESC").all(group);
    return (rows as ProxyRow[]).map(toStored);
  }

  update(p: StoredProxy): void {
    this.db
      .prepare(
        `UPDATE proxies SET name=?, type=?, host=?, port=?, username=?, password=?, timezone=?, provider_id=?, grp=?, updated_at=? WHERE id=?`,
      )
      .run(p.name, p.type, p.host, p.port, p.username, p.password, p.timezone, p.providerId, p.group ?? "default", p.updatedAt, p.id);
  }

  /** Every group with its size and how many of its proxies a live profile uses. */
  groups(): ProxyGroupSummary[] {
    return this.db
      .prepare(
        `SELECT x.grp AS "group", COUNT(*) AS total,
                SUM(CASE WHEN EXISTS (SELECT 1 FROM profiles p WHERE p.proxy_id = x.id AND p.deleted_at IS NULL) THEN 1 ELSE 0 END) AS inUse
           FROM proxies x GROUP BY x.grp ORDER BY x.grp ASC`,
      )
      .all() as ProxyGroupSummary[];
  }

  groupExists(name: string): boolean {
    return this.db.prepare("SELECT 1 AS x FROM proxies WHERE grp = ? LIMIT 1").get(name) !== undefined;
  }

  renameGroup(from: string, to: string): number {
    return this.db
      .prepare("UPDATE proxies SET grp = ?, updated_at = ? WHERE grp = ?")
      .run(to, new Date().toISOString(), from).changes;
  }

  delete(id: string): void {
    this.db.prepare("DELETE FROM proxies WHERE id = ?").run(id);
  }

  /** Profiles referencing this proxy, for delete-safety checks. */
  countUsage(id: string): number {
    const r = this.db
      .prepare("SELECT COUNT(*) AS n FROM profiles WHERE proxy_id = ?")
      .get(id) as { n: number };
    return r.n;
  }

  listByProvider(providerId: string): StoredProxy[] {
    return (
      this.db
        .prepare("SELECT * FROM proxies WHERE provider_id = ? ORDER BY created_at ASC")
        .all(providerId) as ProxyRow[]
    ).map(toStored);
  }

  deleteByProvider(providerId: string): void {
    this.db.prepare("DELETE FROM proxies WHERE provider_id = ?").run(providerId);
  }
}

export interface ProxyHealthEntry {
  proxyId: string;
  checkedAt: string;
  ok: boolean;
  latencyMs: number | null;
  exitIp: string | null;
  geo: ProxyGeo | null;
  error: string | null;
}

interface HealthRow {
  proxy_id: string;
  checked_at: string;
  ok: number;
  latency_ms: number | null;
  exit_ip: string | null;
  geo: string | null;
  error: string | null;
}

function toHealth(r: HealthRow): ProxyHealthEntry {
  let geo: ProxyGeo | null = null;
  if (r.geo) {
    try {
      geo = JSON.parse(r.geo) as ProxyGeo;
    } catch {
      geo = null;
    }
  }
  return {
    proxyId: r.proxy_id,
    checkedAt: r.checked_at,
    ok: r.ok === 1,
    latencyMs: r.latency_ms,
    exitIp: r.exit_ip,
    geo,
    error: r.error,
  };
}

export class ProxyHealthRepository {
  /** Newest-N-per-proxy retention cap. */
  static readonly KEEP = 200;

  constructor(private readonly db: Db) {}

  record(e: ProxyHealthEntry): void {
    this.db
      .prepare(
        `INSERT INTO proxy_health (proxy_id, checked_at, ok, latency_ms, exit_ip, geo, error)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.proxyId,
        e.checkedAt,
        e.ok ? 1 : 0,
        e.latencyMs,
        e.exitIp,
        e.geo ? JSON.stringify(e.geo) : null,
        e.error,
      );
    // Bound the table: keep the newest KEEP rows for this proxy.
    this.db
      .prepare(
        `DELETE FROM proxy_health WHERE proxy_id = ? AND id NOT IN (
           SELECT id FROM proxy_health WHERE proxy_id = ? ORDER BY checked_at DESC, id DESC LIMIT ?
         )`,
      )
      .run(e.proxyId, e.proxyId, ProxyHealthRepository.KEEP);
  }

  /** Newest first. `limit` caps the return, not the retention. */
  history(proxyId: string, limit = 50): ProxyHealthEntry[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM proxy_health WHERE proxy_id = ? ORDER BY checked_at DESC, id DESC LIMIT ?",
        )
        .all(proxyId, Math.min(Math.max(limit, 1), 500)) as HealthRow[]
    ).map(toHealth);
  }
}
