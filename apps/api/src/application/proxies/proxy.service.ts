import { randomUUID } from "node:crypto";
import {
  DomainError,
  ErrorCodes,
  type CreateProxyInput,
  type Proxy,
  type ProxyType,
  type UpdateProxyInput,
} from "@queuepilot/contracts";
import { parseProxyLine, type ProxyImportResult } from "./proxy-import.js";
import { publicProxy, type ProxyRepository, type StoredProxy, type ProxyHealthRepository, type ProxyHealthEntry } from "./proxy.repository.js";
import { probeProxy, DEFAULT_PROBE_URL, type ProxyGeo } from "./proxy-probe.js";
import type { SecretStore } from "../secrets/secret-store.js";

/** Secret key shape for a proxy password. */
export function proxySecretKey(proxyId: string): string {
  return `proxy:${proxyId}:password`;
}

/** Dedupe key for imports: same host (case-insensitive) and port = same proxy. */
function endpointKey(host: string, port: number): string {
  return `${host.toLowerCase()}:${port}`;
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
    /** v0.16.0: when present, every test() result lands in proxy_health. */
    private readonly health?: ProxyHealthRepository,
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
      timezone: input.timezone ?? null,
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

  /**
   * Bulk import from text. Dedupes on host+port against what is stored and
   * within the batch (skipped, not an error); a bad line is recorded and the
   * rest still import — one bad line never fails the batch.
   */
  importText(text: string, defaultType: ProxyType): ProxyImportResult {
    const seen = new Set(this.proxies.list().map((p) => endpointKey(p.host, p.port)));
    const result: ProxyImportResult = { added: 0, skipped: 0, errors: [] };
    for (const [i, raw] of text.split(/\r?\n/).entries()) {
      try {
        const parsed = parseProxyLine(raw, defaultType);
        if (!parsed) continue;
        const key = endpointKey(parsed.host, parsed.port);
        if (seen.has(key)) {
          result.skipped++;
          continue;
        }
        this.create(parsed);
        seen.add(key);
        result.added++;
      } catch (err) {
        result.errors.push({ line: i + 1, reason: err instanceof Error ? err.message : String(err) });
      }
    }
    return result;
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
   * Real validation (v0.15.1, audit G3): makes an actual request THROUGH the
   * proxy to a geo-IP echo service and reports the exit IP + geo a target
   * site would see. A bare TCP connect proved the port answers; this proves
   * the tunnel carries traffic and the credentials work. Failures come back
   * as { ok: false, error } — a dead proxy is data, not an exception.
   * `probeUrl` is injectable so tests can substitute a local fake.
   */
  async test(
    id: string,
    timeoutMs = 4000,
    probeUrl = DEFAULT_PROBE_URL,
  ): Promise<{
    ok: boolean;
    latencyMs: number | null;
    error: string | null;
    exitIp: string | null;
    geo: ProxyGeo | null;
  }> {
    const p = this.getStored(id);
    const started = Date.now();
    const r = await probeProxy(
      { type: p.type, host: p.host, port: p.port, username: p.username, password: p.password },
      probeUrl,
      timeoutMs,
    );
    // Audit GPT-5.4 finding 5f: latency was Date.now()-based twice (once
    // for the health record, once for the response) — read it once so the
    // two can never disagree.
    const latencyMs = r.ok ? Date.now() - started : null;
    this.health?.record({
      proxyId: id,
      checkedAt: new Date().toISOString(),
      ok: r.ok,
      latencyMs,
      exitIp: r.exitIp,
      geo: r.geo,
      error: r.error,
    });
    return { ok: r.ok, latencyMs, error: r.error, exitIp: r.exitIp, geo: r.geo };
  }

  /** Validation history, newest first (empty when no health repo is wired). */
  healthHistory(id: string, limit = 50): ProxyHealthEntry[] {
    this.getStored(id);
    return this.health?.history(id, limit) ?? [];
  }
}
