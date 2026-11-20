export * from "./profile.js";
export * from "./proxy.js";
export * from "./browser-run.js";
export * from "./launch-identity.js";
export * from "./engine.js";
export * from "./adspower.js";
export * from "./providers.js";
export * from "./tabs.js";
export * from "./tab-state.js";
export * from "./attestation.js";
export * from "./settings.js";

/**
 * Domain error codes shared across the API, the UI and automation clients.
 * Machine-stable: message text may change, codes may not.
 */
export const ErrorCodes = {
  PROFILE_NOT_FOUND: "PROFILE_NOT_FOUND",
  PROXY_NOT_FOUND: "PROXY_NOT_FOUND",
  PROXY_UNSUPPORTED: "PROXY_UNSUPPORTED",
  PROVIDER_NOT_FOUND: "PROVIDER_NOT_FOUND",
  PROVIDER_SOURCE_UNREADABLE: "PROVIDER_SOURCE_UNREADABLE",
  RUN_NOT_FOUND: "RUN_NOT_FOUND",
  PROFILE_ALREADY_RUNNING: "PROFILE_ALREADY_RUNNING",
  HOST_AT_CAPACITY: "HOST_AT_CAPACITY",
  PROFILE_NOT_RUNNING: "PROFILE_NOT_RUNNING",
  ENGINE_UNAVAILABLE: "ENGINE_UNAVAILABLE",
  ENGINE_LAUNCH_FAILED: "ENGINE_LAUNCH_FAILED",
  ENGINE_DOWNLOAD_REQUIRES_CONSENT: "ENGINE_DOWNLOAD_REQUIRES_CONSENT",
  ENGINE_CHECKSUM_MISMATCH: "ENGINE_CHECKSUM_MISMATCH",
  ENGINE_MANIFEST_INVALID: "ENGINE_MANIFEST_INVALID",
  TABS_UNSUPPORTED: "TABS_UNSUPPORTED",
  ATTESTATION_UNSUPPORTED: "ATTESTATION_UNSUPPORTED",
  TAB_NOT_FOUND: "TAB_NOT_FOUND",
  GOOGLE_NOT_CONFIGURED: "GOOGLE_NOT_CONFIGURED",
  GOOGLE_NOT_CONNECTED: "GOOGLE_NOT_CONNECTED",
  VALIDATION_FAILED: "VALIDATION_FAILED",
  BUNDLE_INVALID: "BUNDLE_INVALID",
  CONFLICT: "CONFLICT",
  NO_FILL_TARGET: "NO_FILL_TARGET",
  /** Team server (P7.7) — remote sync failures keep their own code space. */
  TEAM_UNAUTHORIZED: "TEAM_UNAUTHORIZED",
  TEAM_NOT_FOUND: "TEAM_NOT_FOUND",
  TEAM_UNAVAILABLE: "TEAM_UNAVAILABLE",
  TEAM_REVISION_CONFLICT: "TEAM_REVISION_CONFLICT",
  /** P7.7b — another machine holds the launch lease for this profile. */
  TEAM_LEASE_HELD: "TEAM_LEASE_HELD",
  /** v0.15.0 — authenticated but the operation is not permitted (e.g. raw cookie export without a token-configured install). */
  FORBIDDEN: "FORBIDDEN",
  /** v0.16.0 — warmup recipe id does not exist under <dataDir>/warmups. */
  WARMUP_NOT_FOUND: "WARMUP_NOT_FOUND",
  EMAIL_ACCOUNT_NOT_FOUND: "EMAIL_ACCOUNT_NOT_FOUND",
  AGENT_CHAT_NOT_FOUND: "AGENT_CHAT_NOT_FOUND",
  /** v0.16.0 — unexpected internal failure (e.g. a corrupt on-disk recipe). */
  INTERNAL: "INTERNAL",
} as const;
export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export class DomainError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "DomainError";
    this.code = code;
  }
}
