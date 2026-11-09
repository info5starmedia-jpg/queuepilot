import { DomainError, ErrorCodes } from "@queuepilot/contracts";
import { ZodError } from "zod";

/** Domain/Zod errors -> stable HTTP codes for the native API. */
export function toHttpError(err: unknown): { status: number; body: { error: { code: string; message: string } } } {
  if (err instanceof ZodError) {
    return {
      status: 400,
      body: {
        error: {
          code: ErrorCodes.VALIDATION_FAILED,
          message: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        },
      },
    };
  }
  if (err instanceof DomainError) {
    const status =
      err.code === ErrorCodes.PROFILE_NOT_FOUND ||
      err.code === ErrorCodes.PROXY_NOT_FOUND ||
      err.code === ErrorCodes.RUN_NOT_FOUND
        ? 404
        : err.code === ErrorCodes.PROFILE_ALREADY_RUNNING || err.code === ErrorCodes.CONFLICT
          ? 409
          : err.code === ErrorCodes.ENGINE_UNAVAILABLE
            ? 503
            : 500;
    return { status, body: { error: { code: err.code, message: err.message } } };
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
