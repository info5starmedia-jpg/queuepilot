import { randomUUID } from "node:crypto";
import type { SecretStore } from "../secrets/secret-store.js";
import { normalizeTotpSeed, totpSecretKey } from "../profiles/totp.service.js";
import fs from "node:fs";
import {
  DomainError,
  ErrorCodes,
  parseCsv,
  parseProfileRows,
  parseProxyRows,
  type CreateProfileProviderInput,
  type CreateProxyProviderInput,
  type CsvImportIssue,
  type ImportedProfile,
  type ProfileProvider,
  type ProxyProvider,
} from "@queuepilot/contracts";
import type {
  ProfileProviderRepository,
  ProxyProviderRepository,
} from "./provider.repository.js";
import type {
  ProfileRepository,
  FingerprintIdentityRepository,
} from "../profiles/profile.repository.js";
import { generateIdentity } from "../profiles/fingerprint-generator.js";
import { hostMemoryGb, hostPrimaryDisplay } from "../profiles/host-display.js";
import type {
  ProxyRepository,
  StoredProxy,
} from "../proxies/proxy.repository.js";
import type { Proxy } from "@queuepilot/contracts";
import { publicProxy } from "../proxies/proxy.repository.js";
import type { SheetReader } from "../google/sheets-client.js";
import { resolveContainedPath } from "../paths/contained-path.js";
import { sealCardsInExtra } from "../profiles/card-secrets.js";

export interface RefreshResult {
  imported: number;
  updated: number;
  issues: CsvImportIssue[];
}

/**
 * Audit A-rec #2 (v0.15.0): sourcePath arrives over HTTP, so on loopback any
 * web page could point a provider at an arbitrary local file. Reads are
 * confined to `sourceRoots` (production: `<dataDir>/imports`), and symlinks
 * are refused outright.
 */
function readSource(provider: {
  sourcePath: string | null;
  name: string;
}, sourceRoots: string[]): string {
  try {
    const safe = resolveContainedPath(provider.sourcePath!, sourceRoots);
    return fs.readFileSync(safe, "utf8");
  } catch (err) {
    if (err instanceof DomainError) throw err;
    throw new DomainError(
      ErrorCodes.PROVIDER_SOURCE_UNREADABLE,
      `cannot read ${provider.sourcePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Default range: all columns of the first sheet. */
const DEFAULT_SHEET_RANGE = "A:ZZ";

/**
 * Profile providers: refreshable external sources of profiles (CSV first).
 *
 * Upsert semantics on refresh, keyed by (providerId, Profile-column value):
 *  - NEW key → create the profile (with a fresh fingerprint identity).
 *  - EXISTING key → update the data fields only. Identity, proxy assignment
 *    and run state are never touched by a refresh — re-importing your CSV
 *    must not churn fingerprints (that's how accounts get linked).
 */
export class ProfileProviderService {
  constructor(
    private readonly providers: ProfileProviderRepository,
    private readonly profiles: ProfileRepository,
    private readonly identities: FingerprintIdentityRepository,
    private readonly sheets?: SheetReader,
    /**
     * SecretStore for the TOTP import column: seeds land keyed by identity
     * (persona), never in the profile row. Optional so test contexts without
     * secrets simply skip seeding (the column is dropped loudly in issues).
     */
    private readonly secrets?: SecretStore | undefined,
    /**
     * v0.15.0 (audit A-rec #2): directories a CSV sourcePath is allowed to
     * live in. Production wires `<dataDir>/imports`; tests wire the dataDir.
     */
    private readonly sourceRoots: string[] = [],
  ) {}

  async create(
    input: CreateProfileProviderInput,
  ): Promise<{ provider: ProfileProvider; refresh: RefreshResult }> {
    const now = new Date().toISOString();
    const provider: ProfileProvider = {
      id: randomUUID(),
      name: input.name,
      type: input.sheetId ? "googleSheet" : "csv",
      sourcePath: input.sourcePath ?? null,
      sheetId: input.sheetId ?? null,
      sheetRange: input.sheetRange ?? null,
      lastRefreshedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    // Validate before persisting: an unreadable source is a named error.
    await this.readRows(provider);
    this.providers.create(provider);
    const refresh = await this.refresh(provider.id);
    return { provider: this.get(provider.id), refresh };
  }

  get(id: string): ProfileProvider {
    const p = this.providers.get(id);
    if (!p)
      throw new DomainError(
        ErrorCodes.PROVIDER_NOT_FOUND,
        `profile provider ${id} not found`,
      );
    return p;
  }

  list(): ProfileProvider[] {
    return this.providers.list();
  }

  async refresh(id: string): Promise<RefreshResult> {
    const provider = this.get(id);
    const { profiles: imported, issues } = parseProfileRows(
      await this.readRows(provider),
    );
    let created = 0;
    let updated = 0;
    const now = new Date().toISOString();

    for (const row of imported) {
      const existing = this.profiles.getByProviderKey(provider.id, row.key);
      if (existing) {
        this.profiles.update({
          ...existing,
          name: row.name,
          group: row.group ?? existing.group,
          email: row.email,
          notes: row.notes ?? existing.notes,
          // PANs sealed into the SecretStore; CVVs discarded (audit v0.15.0).
          extra: sealCardsInExtra(existing.id, existing.extra, extraOf(row), this.secrets),
          updatedAt: now,
        });
        updated++;
        this.storeTotpSeed(existing.identityId, row);
      } else {
        const identity = generateIdentity("windows", "UTC", "en-US", undefined, hostPrimaryDisplay(), hostMemoryGb());
        this.identities.create(identity);
        const id = randomUUID();
        this.profiles.create({
          id,
          name: row.name,
          group: row.group ?? provider.name, // missing group = provider name
          proxyId: null,
          identityId: identity.id,
          status: "idle",
          notes: row.notes ?? "",
          tags: [],
          email: row.email,
          providerId: provider.id,
          providerKey: row.key,
          extra: sealCardsInExtra(id, {}, extraOf(row), this.secrets),
          createdAt: now,
          updatedAt: now,
        });
        created++;
        this.storeTotpSeed(identity.id, row);
      }
    }

    this.providers.update({
      ...provider,
      lastRefreshedAt: now,
      updatedAt: now,
    });
    return { imported: created, updated, issues };
  }

  /** Deleting a provider detaches its profiles; it never deletes them. */
  delete(id: string): void {
    this.get(id);
    this.profiles.detachProvider(id);
    this.providers.delete(id);
  }

  /**
   * TOTP import column → SecretStore, keyed by the profile's identity
   * (the persona owns the seed). Without a SecretStore or an identity the
   * seed is dropped loudly rather than silently landing in `extra`.
   */
  private storeTotpSeed(identityId: string | null, row: ImportedProfile): void {
    if (!row.totp) return;
    if (!this.secrets || !identityId) {
      throw new DomainError(
        ErrorCodes.VALIDATION_FAILED,
        `row "${row.key}": TOTP seed present but no secret store / identity to hold it`,
      );
    }
    this.secrets.set(totpSecretKey(identityId), normalizeTotpSeed(row.totp));
  }

  /** Source rows: CSV file via the RFC-4180 reader, or a live Google Sheet. */
  private async readRows(provider: ProfileProvider): Promise<string[][]> {
    if (provider.type === "googleSheet") {
      if (!this.sheets) {
        throw new DomainError(
          ErrorCodes.GOOGLE_NOT_CONNECTED,
          "Google is not connected — visit /google/auth/url and complete the flow",
        );
      }
      return this.sheets.getValues(
        provider.sheetId!,
        provider.sheetRange ?? DEFAULT_SHEET_RANGE,
      );
    }
    return parseCsv(readSource(provider, this.sourceRoots));
  }
}

/** Everything past the core fields rides in the profile's `extra` bag. */
function extraOf(row: ImportedProfile): Record<string, unknown> {
  return {
    tabColor: row.tabColor,
    address: row.address,
    dob: row.dob,
    phone: row.phone,
    smsNumbers: row.smsNumbers,
    passcodes: row.passcodes,
    free: row.free,
    proxies: row.proxies,
    url: row.url,
    timeZone: row.timeZone,
    favorite: row.favorite,
    creditCards: row.creditCards,
  };
}

/**
 * Proxy providers: refreshable delimited files that fill the proxy pool.
 * Refresh REPLACES the provider's proxies (a provider file is the source of
 * truth for its own entries), refusing if any of its proxies are in use.
 * Distribution modes control what next() hands out:
 *  - persist:    same entry every call (cursor frozen) — stable per operator
 *  - start-over: walks the list, wraps at the end
 *  - random:     uniform pick, cursor untouched
 */
export class ProxyProviderService {
  constructor(
    private readonly providers: ProxyProviderRepository,
    private readonly proxies: ProxyRepository,
    private readonly sheets?: SheetReader,
    /** P6: when present, imported passwords go to the SecretStore, never the row. */
    private readonly secrets?: import("../secrets/secret-store.js").SecretStore,
    /**
     * v0.15.0 (audit A-rec #2): directories a sourcePath is allowed to live
     * in. Production wires `<dataDir>/imports`; tests wire the dataDir.
     */
    private readonly sourceRoots: string[] = [],
  ) {}

  async create(
    input: CreateProxyProviderInput,
  ): Promise<{ provider: ProxyProvider; refresh: RefreshResult }> {
    const now = new Date().toISOString();
    const provider: ProxyProvider = {
      id: randomUUID(),
      name: input.name,
      type: input.sheetId ? "googleSheet" : "file",
      sourcePath: input.sourcePath ?? null,
      sheetId: input.sheetId ?? null,
      sheetRange: input.sheetRange ?? null,
      delimiter: input.delimiter ?? ",",
      hasHeader: input.hasHeader ?? false,
      distribution: input.distribution ?? "start-over",
      cursor: 0,
      starred: false,
      lastRefreshedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.readRows(provider);
    this.providers.create(provider);
    const refresh = await this.refresh(provider.id);
    return { provider: this.get(provider.id), refresh };
  }

  get(id: string): ProxyProvider {
    const p = this.providers.get(id);
    if (!p)
      throw new DomainError(
        ErrorCodes.PROVIDER_NOT_FOUND,
        `proxy provider ${id} not found`,
      );
    return p;
  }

  list(): ProxyProvider[] {
    return this.providers.list();
  }

  /**
   * Star/unstar — Jancy's pin-as-default. Starring one provider clears the
   * star on every other (there is at most one default); unstar leaves the
   * rest untouched.
   */
  setStarred(id: string, starred: boolean): ProxyProvider {
    const target = this.get(id);
    if (starred) {
      for (const p of this.providers.list()) {
        if (p.id !== id && p.starred) {
          this.providers.update({ ...p, starred: false, updatedAt: new Date().toISOString() });
        }
      }
    }
    this.providers.update({ ...target, starred, updatedAt: new Date().toISOString() });
    return this.get(id);
  }

  async refresh(id: string): Promise<RefreshResult> {
    const provider = this.get(id);
    const { proxies: imported, issues } = parseProxyRows(
      await this.readRows(provider),
      {
        hasHeader: provider.hasHeader,
      },
    );

    const existing = this.proxies.listByProvider(provider.id);
    for (const proxy of existing) {
      if (this.proxies.countUsage(proxy.id) > 0) {
        throw new DomainError(
          ErrorCodes.CONFLICT,
          `cannot refresh: proxy "${proxy.name}" from this provider is attached to a profile; detach it first`,
        );
      }
    }

    const now = new Date().toISOString();
    // P6: purge the outgoing rows' secrets with the rows themselves, so a
    // refresh never leaves orphaned password blobs behind.
    if (this.secrets) {
      for (const proxy of existing) {
        this.secrets.delete(`proxy:${proxy.id}:password`);
      }
    }
    // A refresh re-creates the rows; the group the owner filed each proxy
    // under survives it (matched on host+port).
    const priorGroup = new Map(
      this.proxies.listByProvider(provider.id).map((p) => [`${p.host.toLowerCase()}:${p.port}`, p.group]),
    );
    this.proxies.deleteByProvider(provider.id);
    for (const row of imported) {
      const id = randomUUID();
      const stored: StoredProxy = {
        id,
        name: row.name,
        type: "http",
        host: row.host,
        port: row.port,
        username: row.username,
        password: null,
        timezone: row.timezone,
        providerId: provider.id,
        group: priorGroup.get(`${row.host.toLowerCase()}:${row.port}`) ?? "default",
        createdAt: now,
        updatedAt: now,
      };
      if (row.password && this.secrets) {
        this.secrets.set(`proxy:${id}:password`, row.password);
      } else {
        stored.password = row.password;
      }
      this.proxies.create(stored);
    }

    this.providers.update({
      ...provider,
      cursor: 0,
      lastRefreshedAt: now,
      updatedAt: now,
    });
    return { imported: imported.length, updated: 0, issues };
  }

  /** Next proxy per the provider's distribution mode. */
  next(id: string): Proxy {
    const provider = this.get(id);
    return publicProxy(this.pickNext(provider));
  }

  /**
   * D-003 rotation-link resolution: the STORED (credential-bearing) proxy a
   * launch should use. next() strips passwords for the public contract;
   * launches need them, so this path returns the hydrated row.
   *   rotate  — pickNext (cursor advances under start-over)
   *   persist — the pool's current cursor entry, stable across launches
   */
  resolveRotation(link: { providerId: string; mode: "rotate" | "persist" }): StoredProxy {
    const provider = this.get(link.providerId);
    const pool = this.proxies.listByProvider(provider.id);
    if (pool.length === 0) {
      throw new DomainError(
        ErrorCodes.PROXY_NOT_FOUND,
        `provider ${provider.name} has no proxies — refresh it first`,
      );
    }
    if (link.mode === "persist") {
      return pool[Math.min(provider.cursor, pool.length - 1)]!;
    }
    return this.pickNext(provider);
  }

  private pickNext(provider: ProxyProvider): StoredProxy {
    const pool = this.proxies.listByProvider(provider.id);
    if (pool.length === 0) {
      throw new DomainError(
        ErrorCodes.PROXY_NOT_FOUND,
        `provider ${provider.name} has no proxies — refresh it first`,
      );
    }
    let picked: StoredProxy;
    if (provider.distribution === "random") {
      picked = pool[Math.floor(Math.random() * pool.length)]!;
    } else {
      const idx = Math.min(provider.cursor, pool.length - 1);
      picked = pool[idx]!;
      if (provider.distribution === "start-over") {
        this.providers.update({
          ...provider,
          cursor: (idx + 1) % pool.length,
          updatedAt: new Date().toISOString(),
        });
      }
    }
    return picked;
  }

  /** Deleting a provider deletes its proxies, unless any are in use. */
  delete(id: string): void {
    this.get(id);
    const owned = this.proxies.listByProvider(id);
    for (const proxy of owned) {
      if (this.proxies.countUsage(proxy.id) > 0) {
        throw new DomainError(
          ErrorCodes.CONFLICT,
          `proxy "${proxy.name}" from this provider is attached to a profile; detach it first`,
        );
      }
    }
    this.proxies.deleteByProvider(id);
    this.providers.delete(id);
  }

  /** Source rows: delimited file, or a live Google Sheet. */
  private async readRows(provider: ProxyProvider): Promise<string[][]> {
    if (provider.type === "googleSheet") {
      if (!this.sheets) {
        throw new DomainError(
          ErrorCodes.GOOGLE_NOT_CONNECTED,
          "Google is not connected — visit /google/auth/url and complete the flow",
        );
      }
      return this.sheets.getValues(
        provider.sheetId!,
        provider.sheetRange ?? DEFAULT_SHEET_RANGE,
      );
    }
    return readSource(provider, this.sourceRoots)
      .split(/\r?\n/)
      .filter((l) => l.trim() !== "")
      .map((l) => l.split(provider.delimiter).map((c) => c.trim()));
  }
}
