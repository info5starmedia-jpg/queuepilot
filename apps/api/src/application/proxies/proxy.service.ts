import { randomUUID } from "node:crypto";
import net from "node:net";
import {
  DomainError,
  ErrorCodes,
  type CreateProxyInput,
  type Proxy,
  type UpdateProxyInput,
} from "@queuepilot/contracts";
import { publicProxy, type ProxyRepository, type StoredProxy } from "./proxy.repository.js";
import type { SecretStore } from "../secrets/secret-store.js";

/** Secret key shape for a proxy password. */
export function proxySecretKey(proxyId: string): string {
  return `proxy:${proxyId}:password`;
}

export class ProxyService {
  /**
   * @param secrets when present, proxy passwords live in the SecretStore
   *        (DPAPI on Windows) and the SQLite row carries NULL — P6. When
   *        absent (legacy/tests), the row carries the password as before.
   *        Rows written before P6 are migrated lazily on first read.
   */
  constructor(
    private readonly proxies: ProxyRepository,
    private readonly secrets: SecretStore | null = null,
  ) {}

  create(input: CreateProxyInput): Proxy {
    const now = new Date().toISOString();
    const id = randomUUID();
    const stored: StoredProxy = {
      id,
      name: input.name,
      type: input.type,
      host: input.host,
      port: input.port,
      username: input.username ?? null,
      password: null,
      timezone: null,
      providerId: null,
      createdAt: now,
      updatedAt: now,
    };
    if (input.password != null && this.secrets) {
      this.secrets.set(proxySecretKey(id), input.password);
    } else {
      stored.password = input.password ?? null;
    }
    this.proxies.create(stored);
    return publicProxy(stored);
  }

  get(id: string): Proxy {
    return publicProxy(this.getStored(id));
  }

  getStored(id: string): StoredProxy {
    const p = this.proxies.get(id);
    if (!p) throw new DomainError(ErrorCodes.PROXY_NOT_FOUND, `proxy ${id} not found`);
    return this.hydrate(p);
  }

  list(): Proxy[] {
    return this.proxies.list().map(publicProxy);
  }

  update(id: string, input: UpdateProxyInput): Proxy {
    const p = this.getStored(id);
    if (input.password !== undefined && this.secrets) {
      const key = proxySecretKey(id);
      if (input.password === null) this.secrets.delete(key);
      else this.secrets.set(key, input.password);
    }
    const next: StoredProxy = {
      ...p,
      name: input.name ?? p.name,
      type: input.type ?? p.type,
      host: input.host ?? p.host,
      port: input.port ?? p.port,
      username: input.username === undefined ? p.username : input.username,
      // The row never carries a password when a SecretStore is wired; the
      // store above already reflects input.password (set/delete/no-op).
      password: this.secrets ? null : input.password === undefined ? p.password : input.password,
      updatedAt: new Date().toISOString(),
    };
    this.proxies.update(next);
    return publicProxy(next);
  }

  delete(id: string): void {
    this.getStored(id);
    const users = this.proxies.countUsage(id);
    if (users > 0) {
      throw new DomainError(
        ErrorCodes.CONFLICT,
        `proxy is used by ${users} profile${users === 1 ? "" : "s"}; detach it first`,
      );
    }
    this.secrets?.delete(proxySecretKey(id));
    this.proxies.delete(id);
  }

  /**
   * Hydrate a stored row with its secret and lazily migrate pre-P6 rows:
   * a non-NULL row password moves into the store and the row is nulled on
   * first read — the plaintext dies without the operator doing anything.
   */
  private hydrate(p: StoredProxy): StoredProxy {
    if (!this.secrets) return p;
    if (p.password !== null) {
      this.secrets.set(proxySecretKey(p.id), p.password);
      const migrated: StoredProxy = { ...p, password: null, updatedAt: new Date().toISOString() };
      this.proxies.update(migrated);
      p = migrated;
    }
    const secret = this.secrets.get(proxySecretKey(p.id));
    return { ...p, password: secret };
  }

  /**
   * Cheap liveness check: TCP connect with a short timeout. This proves the
   * proxy port answers; it does NOT prove the tunnel carries traffic or that
   * credentials work — that needs a real request through it (roadmap P6).
   */
  async test(id: string, timeoutMs = 4000): Promise<{ ok: boolean; latencyMs: number | null; error: string | null }> {
    const p = this.getStored(id);
    const started = Date.now();
    return new Promise((resolve) => {
      const socket = net.connect({ host: p.host, port: p.port });
      const done = (ok: boolean, error: string | null) => {
        socket.destroy();
        resolve({ ok, latencyMs: ok ? Date.now() - started : null, error });
      };
      socket.setTimeout(timeoutMs);
      socket.once("connect", () => done(true, null));
      socket.once("timeout", () => done(false, "timeout"));
      socket.once("error", (err) => done(false, err.message));
    });
  }
}
