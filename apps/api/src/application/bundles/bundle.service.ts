import { DomainError, ErrorCodes } from "@queuepilot/contracts";
import type { ProfileService } from "../profiles/profile.service.js";
import type { ProxyService } from "../proxies/proxy.service.js";
import type { BrowserLifecycleService } from "../lifecycle/browser.lifecycle.service.js";
import {
  createSessionBundle,
  openSessionBundle,
  type BundleCookie,
  type SessionBundleManifest,
} from "./session-bundle.js";

/**
 * BundleService — encrypted session bundle export/import (AliasMode session
 * bundles, parity §2 P1; the P5/roaming foundation).
 *
 * Cookies live INSIDE the running engine: the only supported transport is
 * CDP against a live profile. So both export and import require the profile
 * to be running — export reads what the engine holds; import hands cookies
 * to the engine, which persists them into its own cookie store on clean
 * shutdown. Writing SQLite cookie files ourselves would race the engine and
 * break on every schema bump; this is the honest seam.
 */
export class BundleService {
  constructor(
    private readonly profiles: ProfileService,
    private readonly lifecycle: BrowserLifecycleService,
    private readonly cookies: {
      export(wsEndpoint: string): Promise<BundleCookie[]>;
      import(wsEndpoint: string, cookies: BundleCookie[]): Promise<void>;
    },
    /** v2: proxy matching on export/restore. Null in legacy tests. */
    private readonly proxies: ProxyService | null = null,
  ) {}

  async exportBundle(profileId: string, passphrase: string): Promise<{
    bundle: string; // base64 — the .qpbundle file content
    cookieCount: number;
    tabCount: number;
    exportedAt: string;
  }> {
    const profile = this.profiles.get(profileId);
    if (!this.lifecycle.activeRun(profileId)) {
      throw new DomainError(
        ErrorCodes.PROFILE_NOT_RUNNING,
        `profile ${profileId} must be running to export its session`,
      );
    }
    const session = this.lifecycle.sessionFor(profileId);
    if (!session) {
      throw new DomainError(
        ErrorCodes.PROFILE_NOT_RUNNING,
        `run for ${profileId} was adopted after an API restart; stop and relaunch to export`,
      );
    }
    const cookies = await this.cookies.export(session.wsEndpoint);
    const exportedAt = new Date().toISOString();
    // v2: tabs + profile metadata + a sanitized proxy reference ride along,
    // so the bundle is the whole profile for roaming, not just its cookies.
    const tabUrls = this.lifecycle
      .listTabs(profileId)
      .tabs.filter((t) => t.status === "open" && t.url)
      .map((t) => t.url!) as string[];
    let proxy: SessionBundleManifest["proxy"] = null;
    if (profile.proxyId && this.proxies) {
      try {
        const p = this.proxies.get(profile.proxyId);
        proxy = { type: p.type, host: p.host, port: p.port, username: p.username ?? null };
      } catch {
        proxy = null; // dangling reference — export without it
      }
    }
    const bundle = createSessionBundle(
      passphrase,
      {
        profileName: profile.name,
        engineKind: this.lifecycle.engineKind(),
        exportedAt,
        group: profile.group,
        tags: profile.tags,
        notes: profile.notes,
        tabUrls,
        proxy,
      },
      cookies,
    );
    return {
      bundle: bundle.toString("base64"),
      cookieCount: cookies.length,
      tabCount: tabUrls.length,
      exportedAt,
    };
  }

  /**
   * v2 restore — the roaming entry point: upsert the profile BY NAME from a
   * bundle (create with the bundle's metadata when unknown), optionally
   * start it and finish the import (cookies in, tabs reopened). The proxy
   * is matched to an existing local entry by type/host/port/username; when
   * no match exists the profile is created WITHOUT a proxy and the report
   * says so — credentials never travel (DPAPI is machine-bound by design).
   */
  async restoreBundle(
    passphrase: string,
    bundleBase64: string,
    opts: { startNow?: boolean } = {},
  ): Promise<{
    profileId: string;
    profileName: string;
    created: boolean;
    cookiesImported: number;
    tabsRestored: number;
    proxyMatched: boolean;
    warnings: string[];
  }> {
    let payload;
    try {
      payload = openSessionBundle(passphrase, Buffer.from(bundleBase64, "base64"));
    } catch (err) {
      if (err instanceof DomainError) throw err;
      throw new DomainError(ErrorCodes.BUNDLE_INVALID, "bundle is not valid base64/JSON");
    }
    const m = payload.manifest;
    const warnings: string[] = [];

    let proxyId: string | null = null;
    if (m.proxy && this.proxies) {
      const match = this.proxies
        .list()
        .find(
          (p) =>
            p.type === m.proxy!.type &&
            p.host === m.proxy!.host &&
            p.port === m.proxy!.port &&
            (p.username ?? null) === m.proxy!.username,
        );
      if (match) proxyId = match.id;
      else
        warnings.push(
          `bundle's proxy ${m.proxy.host}:${m.proxy.port} is not on this machine — profile created without it (credentials never travel)`,
        );
    } else if (m.proxy) {
      warnings.push("bundle references a proxy but no proxy service is available");
    }

    const existing = this.profiles.list().find((p) => p.name === m.profileName);
    let profile;
    let created = false;
    if (existing) {
      profile = this.profiles.update(existing.id, {
        ...(m.group ? { group: m.group } : {}),
        ...(m.tags ? { tags: m.tags } : {}),
        ...(m.notes ? { notes: m.notes } : {}),
        ...(proxyId ? { proxyId } : {}),
      });
    } else {
      profile = this.profiles.create({
        name: m.profileName,
        ...(m.group ? { group: m.group } : {}),
        ...(m.tags ? { tags: m.tags } : {}),
        ...(m.notes ? { notes: m.notes } : {}),
        ...(proxyId ? { proxyId } : {}),
        generateFingerprint: true,
      });
      created = true;
    }

    let cookiesImported = 0;
    let tabsRestored = 0;
    if (opts.startNow) {
      await this.lifecycle.start(profile.id);
      const session = this.lifecycle.sessionFor(profile.id);
      if (!session) throw new DomainError(ErrorCodes.PROFILE_NOT_RUNNING, "start did not yield a session");
      await this.cookies.import(session.wsEndpoint, payload.cookies);
      cookiesImported = payload.cookies.length;
      for (const url of m.tabUrls ?? []) {
        try {
          await this.lifecycle.openTab(profile.id, { url });
          tabsRestored++;
        } catch {
          warnings.push(`tab could not be reopened: ${url}`);
        }
      }
    } else if (payload.cookies.length > 0 || (m.tabUrls ?? []).length > 0) {
      warnings.push(
        "startNow was false — cookies and tabs are still inside the bundle; call importBundle on the running profile to finish",
      );
    }

    return {
      profileId: profile.id,
      profileName: profile.name,
      created,
      cookiesImported,
      tabsRestored,
      proxyMatched: proxyId !== null,
      warnings,
    };
  }

  async importBundle(profileId: string, passphrase: string, bundleBase64: string): Promise<{
    imported: number;
    profileName: string;
    exportedAt: string;
  }> {
    this.profiles.get(profileId); // 404 early, before crypto work
    if (!this.lifecycle.activeRun(profileId)) {
      throw new DomainError(
        ErrorCodes.PROFILE_NOT_RUNNING,
        `profile ${profileId} must be running to import a session`,
      );
    }
    const session = this.lifecycle.sessionFor(profileId);
    if (!session) {
      throw new DomainError(
        ErrorCodes.PROFILE_NOT_RUNNING,
        `run for ${profileId} was adopted after an API restart; stop and relaunch to import`,
      );
    }
    let payload;
    try {
      payload = openSessionBundle(passphrase, Buffer.from(bundleBase64, "base64"));
    } catch (err) {
      if (err instanceof DomainError) throw err;
      throw new DomainError(ErrorCodes.BUNDLE_INVALID, "bundle is not valid base64/JSON");
    }
    await this.cookies.import(session.wsEndpoint, payload.cookies);
    return {
      imported: payload.cookies.length,
      profileName: payload.manifest.profileName,
      exportedAt: payload.manifest.exportedAt,
    };
  }
}
