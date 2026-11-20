import { DomainError, ErrorCodes } from "@queuepilot/contracts";
import { ZodError } from "zod";

/** Domain/Zod errors -> stable HTTP codes for the native API. */
export function toHttpError(err: unknown): {
  status: number;
  body: { error: { code: string; message: string } };
} {
  if (err instanceof ZodError) {
    return {
      status: 400,
      body: {
        error: {
          code: ErrorCodes.VALIDATION_FAILED,
          message: err.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; "),
        },
      },
    };
  }
  // Fastify's own client errors (bad JSON, a "__proto__" key, body too
  // large…) carry a 4xx statusCode: keep it instead of reporting a 500.
  if (!(err instanceof DomainError) && err instanceof Error) {
    const sc = (err as { statusCode?: unknown }).statusCode;
    if (typeof sc === "number" && sc >= 400 && sc < 500) {
      return {
        status: sc,
        body: { error: { code: sc === 413 ? "PAYLOAD_TOO_LARGE" : ErrorCodes.VALIDATION_FAILED, message: err.message.slice(0, 300) } },
      };
    }
  }
  if (err instanceof DomainError) {
    const status =
      err.code === ErrorCodes.VALIDATION_FAILED
        ? 400
        : err.code === ErrorCodes.PROFILE_NOT_FOUND ||
      err.code === ErrorCodes.PROXY_NOT_FOUND ||
      err.code === ErrorCodes.RUN_NOT_FOUND ||
      err.code === ErrorCodes.TAB_NOT_FOUND ||
      err.code === ErrorCodes.PROVIDER_NOT_FOUND ||
      err.code === ErrorCodes.TEAM_NOT_FOUND ||
      err.code === ErrorCodes.WARMUP_NOT_FOUND ||
      err.code === ErrorCodes.EMAIL_ACCOUNT_NOT_FOUND ||
      err.code === ErrorCodes.AGENT_CHAT_NOT_FOUND
        ? 404
        : err.code === ErrorCodes.PROFILE_ALREADY_RUNNING ||
            err.code === ErrorCodes.PROFILE_NOT_RUNNING ||
            err.code === ErrorCodes.CONFLICT ||
            err.code === ErrorCodes.TEAM_REVISION_CONFLICT ||
            err.code === ErrorCodes.TEAM_LEASE_HELD ||
            err.code === ErrorCodes.NO_FILL_TARGET
          ? 409
          : err.code === ErrorCodes.ENGINE_UNAVAILABLE ||
              err.code === ErrorCodes.TEAM_UNAVAILABLE
            ? 503
            : err.code === ErrorCodes.TEAM_UNAUTHORIZED
              ? 401
              : err.code === ErrorCodes.FORBIDDEN ||
                  err.code === ErrorCodes.ENGINE_DOWNLOAD_REQUIRES_CONSENT
                ? 403
              : err.code === ErrorCodes.TABS_UNSUPPORTED ||
                err.code === ErrorCodes.ATTESTATION_UNSUPPORTED
              ? 501
              : err.code === ErrorCodes.GOOGLE_NOT_CONFIGURED ||
                  err.code === ErrorCodes.GOOGLE_NOT_CONNECTED
                ? 400
                : err.code === ErrorCodes.PROVIDER_SOURCE_UNREADABLE
                  ? 422
                  : err.code === ErrorCodes.HOST_AT_CAPACITY
                    ? 429
                    : err.code === ErrorCodes.BUNDLE_INVALID
                      ? 422
                      : 500;
    return {
      status,
      body: { error: { code: err.code, message: err.message } },
    };
  }
  return {
    status: 500,
    body: {
      error: {
        code: "INTERNAL",
        message: err instanceof Error ? err.message : "unknown error",
      },
    },
  };
}
