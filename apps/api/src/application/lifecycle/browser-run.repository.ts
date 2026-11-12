import type { Db } from "../../infrastructure/database.js";
import type { BrowserRun, BrowserRunStatus } from "@queuepilot/contracts";

interface RunRow {
  id: string;
  profile_id: string;
  status: BrowserRunStatus;
  pid: number | null;
  debug_port: number | null;
  ws_endpoint: string | null;
  started_at: string;
  stopped_at: string | null;
  last_error: string | null;
}

function toRun(r: RunRow): BrowserRun {
  return {
    id: r.id,
    profileId: r.profile_id,
    status: r.status,
    pid: r.pid,
    debugPort: r.debug_port,
    wsEndpoint: r.ws_endpoint,
    startedAt: r.started_at,
    stoppedAt: r.stopped_at,
    lastError: r.last_error,
  };
}

export class BrowserRunRepository {
  constructor(private readonly db: Db) {}

  /**
   * Insert an occupying run. The partial unique index
   * (one_occupying_run_per_profile) makes a second concurrent insert throw —
   * the storage layer, not a lock in memory, is the final arbiter of the
   * double-launch guard.
   */
  create(run: BrowserRun): void {
    this.db
      .prepare(
        `INSERT INTO browser_runs (id, profile_id, status, pid, debug_port, ws_endpoint, started_at, stopped_at, last_error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(run.id, run.profileId, run.status, run.pid, run.debugPort, run.wsEndpoint, run.startedAt, run.stoppedAt, run.lastError);
  }

  update(run: BrowserRun): void {
    this.db
      .prepare(
        `UPDATE browser_runs SET status=?, pid=?, debug_port=?, ws_endpoint=?, stopped_at=?, last_error=? WHERE id=?`,
      )
      .run(run.status, run.pid, run.debugPort, run.wsEndpoint, run.stoppedAt, run.lastError, run.id);
  }

  get(id: string): BrowserRun | null {
    const r = this.db.prepare("SELECT * FROM browser_runs WHERE id = ?").get(id) as
      | RunRow
      | undefined;
    return r ? toRun(r) : null;
  }

  /** The run currently occupying a profile, if any. */
  occupyingForProfile(profileId: string): BrowserRun | null {
    const r = this.db
      .prepare(
        "SELECT * FROM browser_runs WHERE profile_id = ? AND status IN ('launching','running')",
      )
      .get(profileId) as RunRow | undefined;
    return r ? toRun(r) : null;
  }

  listOccupying(): BrowserRun[] {
    return (
      this.db
        .prepare("SELECT * FROM browser_runs WHERE status IN ('launching','running')")
        .all() as RunRow[]
    ).map(toRun);
  }

  countOccupying(): number {
    const r = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM browser_runs WHERE status IN ('launching','running')",
      )
      .get() as { n: number };
    return r.n;
  }

  /**
   * Host-wide admission slot (AliasMode lifecycle parity): count and insert
   * atomically under BEGIN IMMEDIATE, so two API processes sharing one DB
   * cannot both pass the cap — the check-then-insert race is closed at the
   * storage layer, the same place the per-profile guard lives. maxConcurrent
   * <= 0 means unlimited (previous behavior, and the default).
   *
   * The caller must still hold the per-profile mutex: the partial unique
   * index is what makes the same-profile double-launch throw.
   */
  admit(
    run: BrowserRun,
    maxConcurrent: number,
  ): { admitted: boolean; occupying: number } {
    let occupying = 0;
    const tx = this.db.transaction(() => {
      occupying = this.countOccupying();
      if (maxConcurrent > 0 && occupying >= maxConcurrent) return false;
      this.create(run);
      return true;
    });
    const admitted = tx.immediate();
    return { admitted, occupying };
  }

  listForProfile(profileId: string, limit = 20): BrowserRun[] {
    return (
      this.db
        .prepare("SELECT * FROM browser_runs WHERE profile_id = ? ORDER BY started_at DESC LIMIT ?")
        .all(profileId, limit) as RunRow[]
    ).map(toRun);
  }
}
