import { DomainError, ErrorCodes } from "@queuepilot/contracts";
import type { BundleService } from "../bundles/bundle.service.js";
import {
  TeamServerClient,
  TeamServerError,
} from "./team-client.js";

/**
 * TeamSyncService — moves encrypted session bundles between this machine and
 * the self-hosted team server (P7.7a). This is the MANUAL seam: the operator
 * (or the future background loop, P7.7c) says push/pull and the service does
 * the honest plumbing:
 *
 * - push: BundleService.exportBundle (profile must be running — cookies live
 *   inside the engine) → sealed bytes → server, with optimistic concurrency
 *   when the caller knows the base revision.
 * - pull: server bytes → BundleService.importBundle into the local profile
 *   (import is restore-shaped: it creates/upserts the profile, never touches
 *   machine-bound proxy passwords).
 *
 * What this layer NEVER does: decrypt anything (BundleService owns the only
 * key path), sync secrets (DPAPI stays machine-bound by design), or decide
 * conflicts (a 409 surfaces as a DomainError with the server's revision so
 * the caller can pull and rebase).
 */

export class TeamSyncService {
  constructor(
    private readonly bundles: BundleService,
    private readonly client: TeamServerClient,
  ) {}

  async pushProfile(
    profileId: string,
    passphrase: string,
    opts: { baseRevision?: number } = {},
  ): Promise<{ revision: number; cookieCount: number }> {
    const exported = await this.bundles.exportBundle(profileId, passphrase);
    try {
      const { revision } = await this.client.pushBundle(
        profileId,
        Buffer.from(exported.bundle, "base64"),
        opts.baseRevision,
      );
      return { revision, cookieCount: exported.cookieCount };
    } catch (err) {
      throw toDomain(err);
    }
  }

  async pullProfile(
    passphrase: string,
    profileId: string,
    opts: { startNow?: boolean } = {},
  ): Promise<{
    revision: number;
    profileId: string;
    created: boolean;
    cookiesImported: number;
    /** Bundle still holds cookies/tabs that never reached an engine. */
    cookiesPending: boolean;
    /** The sealed bundle (base64) — pass to finishPull to complete the import. */
    rawBundle: string;
  }> {
    let pulled;
    try {
      pulled = await this.client.pullBundle(profileId);
    } catch (err) {
      throw toDomain(err);
    }
    // restoreBundle is the honest pull seam: it upserts the profile by the
    // manifest's name (a bundle IS the whole profile), starts it when asked
    // (cookies only travel INTO a live engine), and never invents proxy
    // credentials that are machine-bound on the source.
    const rawBundle = pulled.payload.toString("base64");
    const out = await this.bundles.restoreBundle(
      passphrase,
      rawBundle,
      { startNow: opts.startNow ?? true },
    );
    return {
      revision: pulled.revision,
      profileId: out.profileId,
      created: out.created,
      cookiesImported: out.cookiesImported,
      // v0.15.0 (audit B2): true when the bundle still holds cookies/tabs
      // that never reached an engine (startNow:false and the profile wasn't
      // started). The sync loop uses this to hold the watermark back instead
      // of marking a half-imported profile as synced.
      cookiesPending:
        (opts.startNow ?? true) === false &&
        out.warnings.some((w) => w.includes("startNow was false")),
      rawBundle,
    };
  }

  /**
   * Finish a pull whose cookies were left inside the bundle: import them into
   * the LIVE engine of an already-running profile. Throws when the profile is
   * not running — callers check isRunning first.
   */
  async finishPull(
    passphrase: string,
    rawBundle: string,
    localProfileId: string,
  ): Promise<{ imported: number }> {
    return this.bundles.importBundle(localProfileId, passphrase, rawBundle);
  }

  async listRemote(): Promise<
    { profileId: string; revision: number; updatedBy: string; updatedAt: string }[]
  > {
    try {
      const heads = await this.client.listBundles();
      return heads.map((h) => ({
        profileId: h.profileId,
        revision: h.revision,
        updatedBy: h.updatedBy,
        updatedAt: h.updatedAt,
      }));
    } catch (err) {
      throw toDomain(err);
    }
  }
}

function toDomain(err: unknown): DomainError {
  if (err instanceof TeamServerError) {
    if (err.status === 401) {
      return new DomainError(ErrorCodes.TEAM_UNAUTHORIZED, `team server: ${err.message}`);
    }
    if (err.status === 409) {
      const conflict = new DomainError(
        ErrorCodes.TEAM_REVISION_CONFLICT,
        `team server revision conflict: ${err.message}`,
      );
      (conflict as DomainError & { currentRevision?: number | undefined }).currentRevision =
        err.currentRevision;
      return conflict;
    }
    if (err.status === 404) {
      return new DomainError(ErrorCodes.TEAM_NOT_FOUND, `team server: ${err.message}`);
    }
    return new DomainError(ErrorCodes.TEAM_UNAVAILABLE, `team server: ${err.message}`);
  }
  return err instanceof DomainError
    ? err
    : new DomainError(
        ErrorCodes.TEAM_UNAVAILABLE,
        `team server unreachable: ${err instanceof Error ? err.message : String(err)}`,
      );
}
