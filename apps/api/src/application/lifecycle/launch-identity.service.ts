import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  LaunchIdentitySnapshotSchema,
  computeIdentityDrift,
  type FingerprintIdentity,
  type IdentityDrift,
  type LaunchIdentitySnapshot,
  type Profile,
} from "@queuepilot/contracts";

/**
 * LaunchIdentityService — durable, JSON-file-backed launch snapshots.
 *
 * One file per run at `<dataDir>/snapshots/<runId>.json`. Files are used
 * instead of a DB column because a snapshot is write-once, read-rarely audit
 * data — it never needs a migration and survives DB schema changes. Writes
 * are atomic (temp file + rename) so a crash mid-capture cannot leave a
 * half-written snapshot that recovery would misread.
 */
export class LaunchIdentityService {
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, "snapshots");
    fs.mkdirSync(this.dir, { recursive: true });
  }

  capture(args: {
    runId: string;
    profile: Profile;
    identity: FingerprintIdentity | null;
    /** Stored proxy used for the launch, or null when none / a temp proxy. */
    proxyId: string | null;
    proxyUrl: string | null;
    /** Where the launched proxy came from; "temporary" dies with the run. */
    proxySource: "profile" | "temporary" | "none";
    engineKind: string;
  }): LaunchIdentitySnapshot {
    const snapshot: LaunchIdentitySnapshot = {
      id: randomUUID(),
      runId: args.runId,
      profileId: args.profile.id,
      engineKind: args.engineKind,
      identityId: args.identity?.id ?? null,
      identity: args.identity,
      proxyId: args.proxyId,
      proxyUrl: args.proxyUrl,
      proxySource: args.proxySource,
      capturedAt: new Date().toISOString(),
    };
    const validated = LaunchIdentitySnapshotSchema.parse(snapshot);
    const file = this.fileFor(args.runId);
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(validated, null, 2));
    fs.renameSync(tmp, file);
    return validated;
  }

  forRun(runId: string): LaunchIdentitySnapshot | null {
    const file = this.fileFor(runId);
    if (!fs.existsSync(file)) return null;
    return LaunchIdentitySnapshotSchema.parse(
      JSON.parse(fs.readFileSync(file, "utf8")),
    );
  }

  /**
   * Drift of a run's snapshot against the profile's current pointers. Null
   * when the run has no snapshot (e.g. pre-snapshot history rows).
   */
  drift(
    runId: string,
    current: { identityId: string | null; proxyId: string | null },
  ): IdentityDrift | null {
    const snapshot = this.forRun(runId);
    if (!snapshot) return null;
    return computeIdentityDrift(snapshot, current);
  }

  private fileFor(runId: string): string {
    return path.join(this.dir, `${runId}.json`);
  }
}
