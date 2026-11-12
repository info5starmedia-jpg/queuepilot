import { DomainError, ErrorCodes } from "@queuepilot/contracts";
import type { ProfileService } from "../profiles/profile.service.js";
import type { BrowserLifecycleService } from "../lifecycle/browser.lifecycle.service.js";
import {
  createSessionBundle,
  openSessionBundle,
  type BundleCookie,
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
  ) {}

  async exportBundle(profileId: string, passphrase: string): Promise<{
    bundle: string; // base64 — the .qpbundle file content
    cookieCount: number;
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
    const bundle = createSessionBundle(
      passphrase,
      {
        profileName: profile.name,
        engineKind: this.lifecycle.engineKind(),
        exportedAt,
      },
      cookies,
    );
    return {
      bundle: bundle.toString("base64"),
      cookieCount: cookies.length,
      exportedAt,
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
