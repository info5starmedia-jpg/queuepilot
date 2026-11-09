import { z } from "zod";

/**
 * Engine distribution contracts.
 *
 * Engines are never bundled and never auto-downloaded: the app ships a
 * manifest of known engine builds, and an install only happens with explicit
 * user consent, is verified byte-for-byte against the pinned SHA-256, and is
 * written atomically. A mismatched checksum is a hard refusal, never a
 * warning — a tampered engine binary is a supply-chain attack on every
 * account the user owns.
 */
export const EngineManifestEntrySchema = z.object({
  /** Engine kind, e.g. "camoufox" or a future Chromium-based engine. */
  kind: z.string().min(1).max(60),
  version: z.string().min(1).max(60),
  /** OS/arch tag the artifact targets, e.g. "linux-x64". */
  platform: z.string().min(1).max(60),
  url: z.string().url(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  sizeBytes: z.number().int().positive().optional(),
});
export type EngineManifestEntry = z.infer<typeof EngineManifestEntrySchema>;

export const EngineManifestSchema = z.object({
  schemaVersion: z.literal(1),
  engines: z.array(EngineManifestEntrySchema),
});
export type EngineManifest = z.infer<typeof EngineManifestSchema>;

/** Receipt written next to an installed engine; presence + match = installed. */
export const InstalledEngineSchema = z.object({
  kind: z.string().min(1),
  version: z.string().min(1),
  platform: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  url: z.string().url(),
  installedAt: z.string().datetime(),
  /** Absolute path of the engine directory. */
  dir: z.string().min(1),
});
export type InstalledEngine = z.infer<typeof InstalledEngineSchema>;
