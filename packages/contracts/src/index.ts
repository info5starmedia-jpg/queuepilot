export * from "./profile.js";
export * from "./proxy.js";
export * from "./browser-run.js";
export * from "./launch-identity.js";
export * from "./engine.js";
export * from "./adspower.js";

/**
 * Domain error codes shared across the API, the UI and automation clients.
 * Machine-stable: message text may change, codes may not.
 */
export const ErrorCodes = {
  PROFILE_NOT_FOUND: "PROFILE_NOT_FOUND",
  PROXY_NOT_FOUND: "PROXY_NOT_FOUND",
  RUN_NOT_FOUND: "RUN_NOT_FOUND",
  PROFILE_ALREADY_RUNNING: "PROFILE_ALREADY_RUNNING",
  PROFILE_NOT_RUNNING: "PROFILE_NOT_RUNNING",
  ENGINE_UNAVAILABLE: "ENGINE_UNAVAILABLE",
  ENGINE_LAUNCH_FAILED: "ENGINE_LAUNCH_FAILED",
  ENGINE_DOWNLOAD_REQUIRES_CONSENT: "ENGINE_DOWNLOAD_REQUIRES_CONSENT",
  ENGINE_CHECKSUM_MISMATCH: "ENGINE_CHECKSUM_MISMATCH",
  ENGINE_MANIFEST_INVALID: "ENGINE_MANIFEST_INVALID",
  VALIDATION_FAILED: "VALIDATION_FAILED",
  CONFLICT: "CONFLICT",
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
