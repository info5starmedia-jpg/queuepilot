import fs from "node:fs";
import path from "node:path";
import type { BundleService } from "../bundles/bundle.service.js";
import type { SettingsService } from "../settings/settings.service.js";
import { TeamServerClient } from "./team-client.js";
import { TeamSyncService } from "./team-sync.js";

/**
 * TeamSyncLoop (P7.7c) — the background half of team sync. While the
 * operator-invoked push/pull (TeamSyncService) moves a profile ON DEMAND,
 * this loop keeps a machine CURRENT: on every tick it lists the remote
 * bundle heads and imports any whose revision is newer than the last one
 * this machine imported.
 *
 * Conflict policy, stated plainly:
 * - The SERVER revision is the sync watermark. A profile whose head revision
 *   matches our recorded revision is skipped; a newer head is pulled and the
 *   watermark advances only after the import SUCCEEDS.
 * - Pushes stay operator-invoked. The loop never seals/exports: exporting a
 *   bundle reads the LIVE engine cookie jar, and doing that on a timer for
 *   every profile would be a constant re-seal storm. Pull-dominant is the
 *   honest v1; a push side needs dirty-tracking, which is its own design.
 * - Machine-bound secrets never travel (BundleService owns that boundary).
 *
 * Enabled exactly when Settings → Team has all three of serverUrl, token,
 * and syncPassphrase; otherwise every tick is a no-op. State (revision
 * watermarks) lives in dataDir/team-sync-state.json, written atomically.
 */

export interface SyncTickResult {
  enabled: boolean;
  checked: number;
  imported: number;
  failed: number;
}

interface SyncState {
  [profileId: string]: { revision: number; importedAt: string };
}

export class TeamSyncLoop {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly deps: {
      bundles: BundleService;
      settings: SettingsService;
      dataDir: string;
      intervalMs?: number;
      log?: (msg: string) => void;
    },
  ) {}

  private get stateFile(): string {
    return path.join(this.deps.dataDir, "team-sync-state.json");
  }

  private loadState(): SyncState {
    try {
      return JSON.parse(fs.readFileSync(this.stateFile, "utf8")) as SyncState;
    } catch {
      return {};
    }
  }

  private saveState(state: SyncState): void {
    const tmp = `${this.stateFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, this.stateFile);
  }

  /** One pass. Safe to call manually; never throws on remote errors. */
  async tick(): Promise<SyncTickResult> {
    const team = this.deps.settings.get("team");
    if (!team.serverUrl || !team.token || !team.syncPassphrase) {
      return { enabled: false, checked: 0, imported: 0, failed: 0 };
    }
    const sync = new TeamSyncService(
      this.deps.bundles,
      new TeamServerClient(team.serverUrl, team.token),
    );
    const remote = await sync.listRemote();
    const state = this.loadState();
    let imported = 0;
    let failed = 0;
    for (const head of remote) {
      if (state[head.profileId]?.revision === head.revision) continue;
      try {
        await sync.pullProfile(team.syncPassphrase, head.profileId, {
          startNow: false,
        });
        // Watermark keys on the REMOTE profileId: a bundle restored onto a
        // fresh machine gets a NEW local profile id, so the import result's
        // id can never match the head we based the pull on.
        state[head.profileId] = { revision: head.revision, importedAt: new Date().toISOString() };
        imported++;
      } catch (err) {
        failed++;
        this.deps.log?.(
          `team sync: pull ${head.profileId} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    this.saveState(state);
    return { enabled: true, checked: remote.length, imported, failed };
  }

  start(): void {
    if (this.timer) return;
    const interval = this.deps.intervalMs ?? 60_000;
    this.timer = setInterval(() => {
      if (this.running) return; // a slow tick never overlaps itself
      this.running = true;
      void this.tick()
        .catch((err) =>
          this.deps.log?.(`team sync tick failed: ${err instanceof Error ? err.message : String(err)}`),
        )
        .finally(() => {
          this.running = false;
        });
    }, interval);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
