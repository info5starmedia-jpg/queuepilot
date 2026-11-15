/**
 * Team server config (P7.7a). One self-hosted node that moves encrypted
 * session bundles between family/friends machines. The server never sees
 * plaintext: bundle payloads are opaque bytes (AES-256-GCM sealed by the
 * client, passphrase never transmitted), and auth is bearer tokens verified
 * as SHA-256 hashes.
 */

export type TeamRole = "admin" | "operator" | "viewer";

export interface TeamServerConfig {
  host: string;
  port: number;
  /** SQLite file for bundles + token hashes. ":memory:" for tests. */
  dbPath: string;
  /**
   * Bootstrap admin token (env QUEUEPILOT_TEAM_ADMIN_TOKEN). Accepted as
   * role=admin for token minting even when the tokens table is empty —
   * the first machine stands the server up without a database seed.
   * Minted DB tokens work regardless of whether this is set.
   */
  adminToken: string | null;
  /** Machine name recorded as `updatedBy` on pushes this server initiates. */
  machineName: string;
}

export function teamServerConfigFromEnv(env: NodeJS.ProcessEnv = process.env): TeamServerConfig {
  return {
    host: env.QUEUEPILOT_TEAM_HOST ?? "127.0.0.1",
    port: Number(env.QUEUEPILOT_TEAM_PORT ?? 7373),
    dbPath: env.QUEUEPILOT_TEAM_DB ?? "team-server.db",
    adminToken: env.QUEUEPILOT_TEAM_ADMIN_TOKEN ?? null,
    machineName: env.QUEUEPILOT_TEAM_MACHINE ?? "server",
  };
}

/** Bundle payloads are sealed client-side; cap transport size defensively. */
export const MAX_BUNDLE_BYTES = 25 * 1024 * 1024;
