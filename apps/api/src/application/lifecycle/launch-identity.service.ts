import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../../infrastructure/atomic-write.js";
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
    /** Where the launched proxy came from; "temporary"/"profile-list"/"rotation" die with the run. */
    proxySource: "profile" | "temporary" | "profile-list" | "rotation" | "none";
    engineKind: string;
    /** Egress facts the runtime measured at launch (relay/exit/WebRTC). */
    egress?: LaunchIdentitySnapshot["egress"];
    /** Where the run's timezone came from (see the snapshot schema). */
    timezoneSource?: LaunchIdentitySnapshot["timezoneSource"];
    /** Where the run's locale came from (see the snapshot schema). */
    localeSource?: LaunchIdentitySnapshot["localeSource"];
  }): LaunchIdentitySnapshot {
    const snapshot: LaunchIdentitySnapshot = {
      id: randomUUID(),
      runId: args.runId,
      profileId: args.profile.id,
      engineKind: args.engineKind,
      identityId: args.identity?.id ?? null,
      identity: args.identity,
      proxyId: args.proxyId,
      // Secrets at rest: the password lives only in the DPAPI SecretStore.
      proxyUrl: stripProxyPassword(args.proxyUrl),
      proxySource: args.proxySource,
      ...(args.egress ? { egress: args.egress } : {}),
      ...(args.timezoneSource ? { timezoneSource: args.timezoneSource } : {}),
      ...(args.localeSource ? { localeSource: args.localeSource } : {}),
      capturedAt: new Date().toISOString(),
    };
    const validated = LaunchIdentitySnapshotSchema.parse(snapshot);
    writeFileAtomic(this.fileFor(args.runId), JSON.stringify(validated, null, 2));
    return validated;
  }

  /**
   * Boot migration: snapshots written before passwords were stripped carry
   * the proxy password in plain text. Rewrite just those files (atomically)
   * without it. Idempotent — files with nothing to strip are never touched,
   * and an unreadable file is skipped, never a reason to abort boot.
   */
  stripStoredProxyPasswords(): { rewritten: number; skipped: number } {
    let rewritten = 0;
    let skipped = 0;
    for (const name of fs.readdirSync(this.dir)) {
      if (!name.endsWith(".json")) continue;
      const file = path.join(this.dir, name);
      try {
        const raw = JSON.parse(fs.readFileSync(file, "utf8"));
        if (typeof raw?.proxyUrl !== "string") continue;
        const stripped = stripProxyPassword(raw.proxyUrl);
        if (stripped === raw.proxyUrl) continue;
        raw.proxyUrl = stripped;
        writeFileAtomic(file, JSON.stringify(raw, null, 2));
        rewritten++;
      } catch (err) {
        skipped++;
        console.warn(
          `[queuepilot] snapshot ${name}: could not check for a stored proxy password — ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    return { rewritten, skipped };
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

/**
 * Drop the password from a proxy URL, keeping scheme, username, host and
 * port so the snapshot still identifies the proxy. Works on the string so
 * credential-free URLs come back byte-identical (no URL normalization).
 * Anything with an "@" that is not the plain `scheme://user@host` shape is
 * replaced wholesale rather than risk keeping a secret.
 */
export function stripProxyPassword(url: string | null): string | null {
  if (!url) return url;
  const stripped = url.replace(/^([a-z][a-z0-9+.-]*:\/\/[^:@/]*):[^@/]*@/i, "$1@");
  if (!stripped.includes("@")) return stripped;
  if (/^[a-z][a-z0-9+.-]*:\/\/[^:@/]*@[^@]*$/i.test(stripped)) return stripped;
  return "(unparseable proxy url)";
}
