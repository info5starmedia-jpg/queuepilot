import { z } from "zod";
import os from "node:os";
import path from "node:path";

/**
 * Runtime configuration. Everything is an environment variable with a safe
 * default; there is no config file to drift out of sync with the code.
 *
 * SPECTRA_PORT defaults to 50325 — the AdsPower Local API convention — so
 * existing automation tooling can point at QueuePilot by changing nothing but
 * the process it talks to.
 */
const ConfigSchema = z.object({
  port: z.coerce.number().int().min(1).max(65535).default(50325),
  host: z.string().default("127.0.0.1"),
  dataDir: z.string().default(path.join(os.homedir(), ".queuepilot")),
  /**
   * "fake" runs the deterministic in-memory engine (tests, CI, demos).
   * Default "fury": our own BSD Chromium core passed the full detection
   * battery (CreepJS/sannysoft/AliasMode, docs/reports/detection-check-
   * 2026-11-16.md), so the engine we ship is the engine that serves launches.
   * camoufox stays selectable for A/B fallback (SPECTRA_RUNTIME=camoufox).
   */
  runtime: z.enum(["camoufox", "fury", "fake"]).default("fury"),
  /** Optional bearer token. Unset = loopback-only trust (still binds 127.0.0.1). */
  apiToken: z.string().min(8).optional(),
  /** Google Cloud OAuth client (Sheets API) for Google Sheets providers. */
  googleClientId: z.string().optional(),
  googleClientSecret: z.string().optional(),
});

export type AppConfig = z.infer<typeof ConfigSchema> & { dbPath: string };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = ConfigSchema.parse({
    port: env.SPECTRA_PORT,
    host: env.SPECTRA_HOST,
    dataDir: env.SPECTRA_DATA_DIR,
    runtime: env.SPECTRA_RUNTIME,
    apiToken: env.SPECTRA_API_TOKEN,
    googleClientId: env.SPECTRA_GOOGLE_CLIENT_ID,
    googleClientSecret: env.SPECTRA_GOOGLE_CLIENT_SECRET,
  });
  return { ...parsed, dbPath: path.join(parsed.dataDir, "queuepilot.db") };
}
