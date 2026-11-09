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

export class ProxyService {
  constructor(private readonly proxies: ProxyRepository) {}

  create(input: CreateProxyInput): Proxy {
    const now = new Date().toISOString();
    const stored: StoredProxy = {
      id: randomUUID(),
      name: input.name,
      type: input.type,
      host: input.host,
      port: input.port,
      username: input.username ?? null,
      password: input.password ?? null,
      timezone: null,
      providerId: null,
      createdAt: now,
      updatedAt: now,
    };
    this.proxies.create(stored);
    return publicProxy(stored);
  }

  get(id: string): Proxy {
    return publicProxy(this.getStored(id));
  }

  getStored(id: string): StoredProxy {
    const p = this.proxies.get(id);
    if (!p) throw new DomainError(ErrorCodes.PROXY_NOT_FOUND, `proxy ${id} not found`);
    return p;
  }

  list(): Proxy[] {
    return this.proxies.list().map(publicProxy);
  }

  update(id: string, input: UpdateProxyInput): Proxy {
    const p = this.getStored(id);
    const next: StoredProxy = {
      ...p,
      name: input.name ?? p.name,
      type: input.type ?? p.type,
      host: input.host ?? p.host,
      port: input.port ?? p.port,
      username: input.username === undefined ? p.username : input.username,
      password: input.password === undefined ? p.password : input.password,
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
    this.proxies.delete(id);
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
