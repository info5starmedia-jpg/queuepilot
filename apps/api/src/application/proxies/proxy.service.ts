import { randomUUID } from "node:crypto";
import {
  DomainError,
  ErrorCodes,
  type CreateProxyInput,
  type Proxy,
  type ProxyProbe,
  type ProxyType,
  type UpdateProxyInput,
} from "@queuepilot/contracts";
import { parseProxyLine, type ProxyImportResult } from "./proxy-import.js";
import { publicProxy, type ProxyRepository, type StoredProxy, type ProxyHealthRepository, type ProxyHealthEntry, type ProxyGroupSummary } from "./proxy.repository.js";
import { probeProxy, DEFAULT_PROBE_URL, type ProbeResult, type ProxyGeo } from "./proxy-probe.js";
import type { SecretStore } from "../secrets/secret-store.js";

/** Secret key shape for a proxy password. */
export function proxySecretKey(proxyId: string): string {
  return `proxy:${proxyId}:password`;
}

/** A probe stays usable for launch geo this long. */
export const PROBE_FRESH_MS = 24 * 60 * 60 * 1000;

/** A successful probe younger than PROBE_FRESH_MS. */
export function isFreshProbe(probe: ProxyProbe | null | undefined, now = Date.now()): probe is ProxyProbe {
  if (!probe?.ok) return false;
  const age = now - Date.parse(probe.testedAt);
  return age >= 0 && age < PROBE_FRESH_MS;
}

/** Build the stored record from a raw probe result. */
export function toProxyProbe(r: ProbeResult, latencyMs: number | null, testedAt = new Date()): ProxyProbe {
  return {
    ok: r.ok,
    error: r.error,
    exitIp: r.exitIp,
    country: r.geo?.country ?? null,
    countryCode: r.geo?.countryCode ?? null,
    region: r.geo?.region ?? null,
    city: r.geo?.city ?? null,
    timezone: r.geo?.timezone ?? null,
    latencyMs,
    testedAt: testedAt.toISOString(),
  };
}

type ProbeFn = typeof probeProxy;

/**
 * Save-time auto-test. Absent (tests, legacy wiring) = saves never probe;
 * main.ts wires it so every create and endpoint edit probes in the background.
 */
export interface BackgroundProbeOptions {
  /** Defaults to the real probe. */
  probe?: ProbeFn;
  /** Error sink: gets the proxy id and the probe's error, never credentials. */
  log?: (line: string) => void;
  /** Parallel probes (a 1000-line import must not open 1000 sockets). Default 4. */
  concurrency?: number;
}

const BACKGROUND_TIMEOUT_MS = 8_000;

/** In-memory comparison key for "same exit" — never logged or stored. */
function endpointOf(p: StoredProxy): string {
  return JSON.stringify([p.type, p.host, p.port, p.username, p.password]);
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
    private readonly background?: BackgroundProbeOptions,
  ) {}

  private readonly probeQueue: string[] = [];
  private readonly queued = new Set<string>();
  private readonly inflight = new Set<Promise<void>>();

  private get probe(): ProbeFn {
    return this.background?.probe ?? probeProxy;
  }

  /**
   * Queue a background probe (no-op without BackgroundProbeOptions). Runs
   * after the save has returned; failures are logged and stored, never thrown.
   */
  scheduleProbe(id: string): void {
    if (!this.background || this.queued.has(id)) return;
    this.queued.add(id);
    this.probeQueue.push(id);
    this.pumpProbes();
  }

  /** Profile-form save: re-probe the attached proxy only if its result is missing, failed or stale. */
  probeIfStale(id: string): void {
    const p = this.proxies.get(id);
    if (p && !isFreshProbe(p.lastProbe)) this.scheduleProbe(id);
  }

  /** Resolves once every queued and running background probe has finished. */
  async whenProbesIdle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
  }

  private pumpProbes(): void {
    const max = Math.max(1, this.background?.concurrency ?? 4);
    while (this.inflight.size < max && this.probeQueue.length > 0) {
      const id = this.probeQueue.shift()!;
      this.queued.delete(id);
      const job: Promise<void> = this.runProbe(id, BACKGROUND_TIMEOUT_MS, DEFAULT_PROBE_URL)
        .then((r) => {
          if (!r.ok) this.background?.log?.(`proxy ${id} auto-test failed: ${r.error}`);
        })
        .catch((err: unknown) => {
          // Deleted before its turn: nothing to store, nothing to report.
          if (err instanceof DomainError && err.code === ErrorCodes.PROXY_NOT_FOUND) return;
          this.background?.log?.(`proxy ${id} auto-test error: ${err instanceof Error ? err.message : String(err)}`);
        })
        .finally(() => {
          this.inflight.delete(job);
          this.pumpProbes();
        });
      this.inflight.add(job);
    }
  }

  /** Probe through the proxy; store the result on the row and in the health history. */
  private async runProbe(id: string, timeoutMs: number, probeUrl: string): Promise<ProxyProbe> {
    const p = this.getStored(id);
    const started = Date.now();
    const r = await this.probe(
      { type: p.type, host: p.host, port: p.port, username: p.username, password: p.password },
      probeUrl,
      timeoutMs,
    );
    // Audit GPT-5.4 finding 5f: latency is read once so the stored record,
    // the health row and the response can never disagree.
    const latencyMs = r.ok ? Date.now() - started : null;
    const probe = toProxyProbe(r, latencyMs);
    // The endpoint was edited (or the proxy deleted) while this probe ran:
    // its answer describes the old exit, and the edit already queued a new
    // probe — store nothing.
    const now = this.proxies.get(id);
    if (!now || endpointOf(this.hydrate(now)) !== endpointOf(p)) return probe;
    this.recordProbe(id, probe);
    this.health?.record({
      proxyId: id,
      checkedAt: probe.testedAt,
      ok: r.ok,
      latencyMs,
      exitIp: r.exitIp,
      geo: r.geo,
      error: r.error,
    });
    return probe;
  }

  /** Store a probe result on the proxy row (also used by the launch's live lookup). */
  recordProbe(id: string, probe: ProxyProbe): void {
    this.proxies.setLastProbe(id, probe);
  }

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
      group: input.group ?? "default",
      lastProbe: null,
      createdAt: now,
      updatedAt: now,
    };
    if (input.password != null && this.secrets) {
      this.secrets.set(proxySecretKey(id), input.password);
    } else {
      stored.password = input.password ?? null;
    }
    this.proxies.create(stored);
    this.scheduleProbe(id);
    return publicProxy(stored);
  }

  /**
   * Bulk import from text. Dedupes on host+port against what is stored and
   * within the batch (skipped, not an error); a bad line is recorded and the
   * rest still import — one bad line never fails the batch.
   */
  importText(text: string, defaultType: ProxyType, group?: string): ProxyImportResult {
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
        this.create({ ...parsed, group });
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

  list(group?: string): Proxy[] {
    return this.proxies.list(group).map(publicProxy);
  }

  groups(): ProxyGroupSummary[] {
    return this.proxies.groups();
  }

  /** Rename a group; refuses to merge into an existing one (same rule as profile groups). */
  renameGroup(from: string, to: string): { renamed: number } {
    if (from === to) return { renamed: 0 };
    if (this.proxies.groupExists(to)) {
      throw new DomainError(ErrorCodes.CONFLICT, `group "${to}" already exists — move proxies into it instead`);
    }
    const renamed = this.proxies.renameGroup(from, to);
    if (renamed === 0) throw new DomainError(ErrorCodes.PROXY_NOT_FOUND, `group "${from}" not found`);
    return { renamed };
  }

  /**
   * Move proxies into a group (new or existing). Every id is checked before
   * anything moves; each move goes through update(), so secrets keep their
   * normal handling (a pre-P6 plaintext row migrates on the way).
   */
  moveToGroup(ids: string[], group: string): { moved: number } {
    for (const id of ids) this.getStored(id);
    for (const id of ids) this.update(id, { group });
    return { moved: ids.length };
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
      group: input.group ?? p.group,
      // The row never carries a password when a SecretStore is wired; the
      // store above already reflects input.password (set/delete/no-op).
      password: this.secrets ? null : input.password === undefined ? p.password : input.password,
      updatedAt: new Date().toISOString(),
    };
    // A new endpoint or credential means the old probe describes a different
    // exit: drop it and re-test. Name/group edits keep it.
    const endpointChanged =
      next.type !== p.type ||
      next.host !== p.host ||
      next.port !== p.port ||
      next.username !== p.username ||
      input.password !== undefined;
    if (endpointChanged) next.lastProbe = null;
    this.proxies.update(next);
    if (endpointChanged) this.scheduleProbe(id);
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
    lastProbe: ProxyProbe;
  }> {
    const probe = await this.runProbe(id, timeoutMs, probeUrl);
    const geo: ProxyGeo | null = probe.ok
      ? { country: probe.country, countryCode: probe.countryCode, region: probe.region, city: probe.city, timezone: probe.timezone }
      : null;
    return { ok: probe.ok, latencyMs: probe.latencyMs, error: probe.error, exitIp: probe.exitIp, geo, lastProbe: probe };
  }

  /** Validation history, newest first (empty when no health repo is wired). */
  healthHistory(id: string, limit = 50): ProxyHealthEntry[] {
    this.getStored(id);
    return this.health?.history(id, limit) ?? [];
  }
}
