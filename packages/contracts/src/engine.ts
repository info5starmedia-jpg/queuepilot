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
  /**
   * Payload format. "raw" = the payload IS the binary; archive kinds are
   * extracted (system tar) after the checksum passes — the pinned hash covers
   * the archive bytes, so extraction of a verified archive is safe.
   */
  archive: z.enum(["raw", "tar.xz", "tar.gz"]).default("raw"),
  /** Path of the executable inside the payload/archive, e.g. "Fury/chrome.exe". */
  binaryPath: z.string().min(1).optional(),
});
export type EngineManifestEntry = z.infer<typeof EngineManifestEntrySchema>;
/** Input shape — `archive` optional before parsing applies its "raw" default. */
export type EngineManifestEntryInput = z.input<typeof EngineManifestEntrySchema>;

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
  /** Executable path relative to dir, when the manifest declares one. */
  binaryPath: z.string().min(1).optional(),
});
export type InstalledEngine = z.infer<typeof InstalledEngineSchema>;

/**
 * Engine health report (GET /engine/health). Answers the two questions an
 * operator asks before burning accounts: which runtime is serving launches,
 * and is the real engine binary actually where the config says it is.
 */
export const EngineHealthSchema = z.object({
  /** Active runtime kind: "camoufox", "fake", ... */
  runtime: z.string().min(1),
  /** Path the runtime will try to execute, or null when the runtime needs no binary (fake). */
  binaryPath: z.string().nullable(),
  /** True when no binary is required, or the required binary exists on disk. */
  binaryPresent: z.boolean(),
  /** Verified install receipts found under <dataDir>/engines/. */
  installs: z.array(InstalledEngineSchema),
});
export type EngineHealth = z.infer<typeof EngineHealthSchema>;

/**
 * Launch self-test result (POST /engine/self-test): the runtime launches a
 * throwaway browser with a synthetic profile and immediately stops it. Proves
 * the full spawn path (binary, ports, process reaping) works, end to end.
 */
export const EngineSelfTestResultSchema = z.object({
  ok: z.boolean(),
  runtime: z.string().min(1),
  /** Wall-clock time for launch + clean stop. */
  latencyMs: z.number().int().nonnegative().nullable(),
  /** Named failure when ok=false (e.g. ENGINE_UNAVAILABLE message). */
  error: z.string().nullable(),
});
export type EngineSelfTestResult = z.infer<typeof EngineSelfTestResultSchema>;
