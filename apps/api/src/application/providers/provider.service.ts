import { randomUUID } from "node:crypto";
import fs from "node:fs";
import {
  DomainError,
  ErrorCodes,
  parseProfileCsv,
  parseProxyFile,
  type CreateProfileProviderInput,
  type CreateProxyProviderInput,
  type CsvImportIssue,
  type ImportedProfile,
  type ProfileProvider,
  type ProxyProvider,
} from "@queuepilot/contracts";
import type { ProfileProviderRepository, ProxyProviderRepository } from "./provider.repository.js";
import type { ProfileRepository, FingerprintIdentityRepository } from "../profiles/profile.repository.js";
import { generateIdentity } from "../profiles/fingerprint-generator.js";
import type { ProxyRepository, StoredProxy } from "../proxies/proxy.repository.js";
import type { Proxy } from "@queuepilot/contracts";
import { publicProxy } from "../proxies/proxy.repository.js";

export interface RefreshResult {
  imported: number;
  updated: number;
  issues: CsvImportIssue[];
}

function readSource(provider: { sourcePath: string; name: string }): string {
  try {
    return fs.readFileSync(provider.sourcePath, "utf8");
  } catch (err) {
    throw new DomainError(
      ErrorCodes.PROVIDER_SOURCE_UNREADABLE,
      `cannot read ${provider.sourcePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

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
  ) {}

  create(input: CreateProfileProviderInput): { provider: ProfileProvider; refresh: RefreshResult } {
    const now = new Date().toISOString();
    const provider: ProfileProvider = {
      id: randomUUID(),
      name: input.name,
      type: "csv",
      sourcePath: input.sourcePath,
      lastRefreshedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    // Validate before persisting: an unreadable source is a named error.
    readSource(provider);
    this.providers.create(provider);
    const refresh = this.refresh(provider.id);
    return { provider: this.get(provider.id), refresh };
  }

  get(id: string): ProfileProvider {
    const p = this.providers.get(id);
    if (!p) throw new DomainError(ErrorCodes.PROVIDER_NOT_FOUND, `profile provider ${id} not found`);
    return p;
  }

  list(): ProfileProvider[] {
    return this.providers.list();
  }

  refresh(id: string): RefreshResult {
    const provider = this.get(id);
    const { profiles: imported, issues } = parseProfileCsv(readSource(provider));
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
          extra: extraOf(row),
          updatedAt: now,
        });
        updated++;
      } else {
        const identity = generateIdentity("windows");
        this.identities.create(identity);
        this.profiles.create({
          id: randomUUID(),
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
          extra: extraOf(row),
          createdAt: now,
          updatedAt: now,
        });
        created++;
      }
    }

    this.providers.update({ ...provider, lastRefreshedAt: now, updatedAt: now });
    return { imported: created, updated, issues };
  }

  /** Deleting a provider detaches its profiles; it never deletes them. */
  delete(id: string): void {
    this.get(id);
    this.profiles.detachProvider(id);
    this.providers.delete(id);
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
  ) {}

  create(input: CreateProxyProviderInput): { provider: ProxyProvider; refresh: RefreshResult } {
    const now = new Date().toISOString();
    const provider: ProxyProvider = {
      id: randomUUID(),
      name: input.name,
      type: "file",
      sourcePath: input.sourcePath,
      delimiter: input.delimiter ?? ",",
      hasHeader: input.hasHeader ?? false,
      distribution: input.distribution ?? "start-over",
      cursor: 0,
      lastRefreshedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    readSource(provider);
    this.providers.create(provider);
    const refresh = this.refresh(provider.id);
    return { provider: this.get(provider.id), refresh };
  }

  get(id: string): ProxyProvider {
    const p = this.providers.get(id);
    if (!p) throw new DomainError(ErrorCodes.PROVIDER_NOT_FOUND, `proxy provider ${id} not found`);
    return p;
  }

  list(): ProxyProvider[] {
    return this.providers.list();
  }

  refresh(id: string): RefreshResult {
    const provider = this.get(id);
    const { proxies: imported, issues } = parseProxyFile(readSource(provider), {
      delimiter: provider.delimiter,
      hasHeader: provider.hasHeader,
    });

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
    this.proxies.deleteByProvider(provider.id);
    for (const row of imported) {
      const stored: StoredProxy = {
        id: randomUUID(),
        name: row.name,
        type: "http",
        host: row.host,
        port: row.port,
        username: row.username,
        password: row.password,
        timezone: row.timezone,
        providerId: provider.id,
        createdAt: now,
        updatedAt: now,
      };
      this.proxies.create(stored);
    }

    this.providers.update({ ...provider, cursor: 0, lastRefreshedAt: now, updatedAt: now });
    return { imported: imported.length, updated: 0, issues };
  }

  /** Next proxy per the provider's distribution mode. */
  next(id: string): Proxy {
    const provider = this.get(id);
    const pool = this.proxies.listByProvider(provider.id);
    if (pool.length === 0) {
      throw new DomainError(ErrorCodes.PROXY_NOT_FOUND, `provider ${provider.name} has no proxies — refresh it first`);
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
    return publicProxy(picked);
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
}
