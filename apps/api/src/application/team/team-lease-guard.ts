import os from "node:os";
import { DomainError, ErrorCodes } from "@queuepilot/contracts";
import type { SettingsService } from "../settings/settings.service.js";
import {
  TeamServerClient,
  TeamServerError,
} from "./team-client.js";

/**
 * TeamLeaseGuard (P7.7b) — the cross-machine half of the double-start guard.
 * The local guard (one occupying run per profile, enforced by SQLite) stops
 * two starts on ONE machine; this guard stops machine B from starting a
 * profile whose browser is live on machine A.
 *
 * Lifecycle hooks:
 * - acquire() runs BEFORE the launch is admitted; a LEASE_HELD or an
 *   unreachable server FAILS THE START (fail closed — configuring team
 *   mode makes the server infrastructure, and silently starting without
 *   the guard would be the exact race it exists to stop).
 * - release() runs on explicit stop; crashes are cleaned up by the lease
 *   TTL on the server (default 60 s). While a run is live, the lifecycle
 *   heartbeat-calls renew() so a long session never outlives its guard.
 *
 * When team mode is not configured (no serverUrl/token in Settings), every
 * call is a no-op and single-machine behavior is untouched.
 */
export class TeamLeaseGuard {
  readonly holder = `${os.hostname()}:${process.pid}`;

  constructor(
    private readonly settings: SettingsService,
    private readonly ttlMs = 60_000,
  ) {}

  private client(): TeamServerClient | null {
    const team = this.settings.get("team");
    if (!team.serverUrl || !team.token) return null;
    return new TeamServerClient(team.serverUrl, team.token);
  }

  async acquire(profileId: string): Promise<void> {
    const client = this.client();
    if (!client) return;
    try {
      await client.acquireLease(profileId, this.holder, os.hostname(), this.ttlMs);
    } catch (err) {
      if (err instanceof TeamServerError && err.status === 409) {
        throw new DomainError(ErrorCodes.TEAM_LEASE_HELD, err.message);
      }
      throw new DomainError(
        ErrorCodes.TEAM_UNAVAILABLE,
        `team lease unavailable (start refused): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async release(profileId: string): Promise<void> {
    const client = this.client();
    if (!client) return;
    try {
      await client.releaseLease(profileId, this.holder);
    } catch {
      // Best-effort: the TTL reaps a lease whose release was lost.
    }
  }

  /**
   * Lease heartbeat (v0.15.0, audit B1): the server TTL is 60 s, and without
   * renewal a long-running profile silently LOSES its double-start guard one
   * minute after launch. The lifecycle calls this on a timer for every live
   * run; errors are swallowed — a lost renew is retried next tick, and a dead
   * server leaves local behavior untouched.
   */
  async renew(profileId: string): Promise<void> {
    const client = this.client();
    if (!client) return;
    try {
      await client.renewLease(profileId, this.holder, this.ttlMs);
    } catch {
      /* best-effort heartbeat; TTL reaps if the lease is truly gone */
    }
  }
}
