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
