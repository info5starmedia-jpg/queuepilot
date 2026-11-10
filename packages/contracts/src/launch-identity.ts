import { z } from "zod";
import { FingerprintIdentitySchema } from "./profile.js";

/**
 * Launch-identity snapshot contract.
 *
 * The identity of record for a browser run is the SNAPSHOT captured at launch,
 * not the profile's current pointers. This is what makes "edit while running"
 * safe: changing a profile's identity or proxy while its browser is up never
 * mutates the running session — the drift is reported and applies at next
 * start. Engines materialize identity values once at spawn; pretending edits
 * apply live is how multi-account tools get accounts linked.
 */
export const LaunchIdentitySnapshotSchema = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  profileId: z.string().uuid(),
  engineKind: z.string().min(1),
  /** Frozen copies — what the engine was actually launched with. */
  identityId: z.string().uuid().nullable(),
  identity: FingerprintIdentitySchema.nullable(),
  proxyId: z.string().uuid().nullable(),
  /** Prebuilt --proxy-server value captured at launch (credentials included). */
  proxyUrl: z.string().nullable(),
  /**
   * Where the launched proxy came from. "temporary" means a one-shot temp
   * proxy was passed at launch; the profile's own proxy was NOT used and
   * applies again at next start. Defaults to "profile" so snapshots written
   * before this field existed keep their original meaning.
   */
  proxySource: z.enum(["profile", "temporary", "none"]).default("profile"),
  capturedAt: z.string().datetime(),
});
export type LaunchIdentitySnapshot = z.infer<
  typeof LaunchIdentitySnapshotSchema
>;

/** Which inputs drifted since the snapshot was captured. */
export const IdentityDriftSchema = z.object({
  stale: z.boolean(),
  /** Machine-readable list, e.g. ["identity", "proxy"]. */
  fields: z.array(z.enum(["identity", "proxy"])),
  /** Human-facing: "applies at next start". */
  message: z.string(),
});
export type IdentityDrift = z.infer<typeof IdentityDriftSchema>;

/**
 * Diff a launch snapshot against the profile's CURRENT pointers. Pure
 * function so the API, a future UI, and tests all share one definition of
 * "this edit applies at next start".
 *
 * A run launched with a temporary proxy always reports proxy drift: the temp
 * proxy dies with the run, so the profile's own proxy is by definition what
 * applies at next start.
 */
export function computeIdentityDrift(
  snapshot: LaunchIdentitySnapshot,
  current: { identityId: string | null; proxyId: string | null },
): IdentityDrift {
  const fields: IdentityDrift["fields"] = [];
  const messages: string[] = [];
  if (snapshot.identityId !== current.identityId) {
    fields.push("identity");
    messages.push("identity changed while running — applies at next start");
  }
  if (snapshot.proxySource === "temporary") {
    fields.push("proxy");
    messages.push(
      "running on a temporary proxy — the profile's proxy applies at next start",
    );
  } else if (snapshot.proxyId !== current.proxyId) {
    fields.push("proxy");
    messages.push("proxy changed while running — applies at next start");
  }
  const stale = fields.length > 0;
  return {
    stale,
    fields,
    message: stale
      ? messages.join("; ")
      : "running identity matches the profile",
  };
}
