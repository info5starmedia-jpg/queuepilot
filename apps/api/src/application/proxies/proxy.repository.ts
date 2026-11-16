import type { Db } from "../../infrastructure/database.js";
import type { Proxy } from "@queuepilot/contracts";

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
  created_at: string;
  updated_at: string;
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
        `INSERT INTO proxies (id, name, type, host, port, username, password, timezone, provider_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(p.id, p.name, p.type, p.host, p.port, p.username, p.password, p.timezone, p.providerId, p.createdAt, p.updatedAt);
  }

  get(id: string): StoredProxy | null {
    const r = this.db.prepare("SELECT * FROM proxies WHERE id = ?").get(id) as ProxyRow | undefined;
    return r ? toStored(r) : null;
  }

  list(): StoredProxy[] {
    return (this.db.prepare("SELECT * FROM proxies ORDER BY created_at DESC").all() as ProxyRow[]).map(toStored);
  }

  update(p: StoredProxy): void {
    this.db
      .prepare(
        `UPDATE proxies SET name=?, type=?, host=?, port=?, username=?, password=?, timezone=?, provider_id=?, updated_at=? WHERE id=?`,
      )
      .run(p.name, p.type, p.host, p.port, p.username, p.password, p.timezone, p.providerId, p.updatedAt, p.id);
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
  geo: Record<string, unknown> | null;
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
  let geo: Record<string, unknown> | null = null;
  if (r.geo) {
    try {
      geo = JSON.parse(r.geo) as Record<string, unknown>;
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
