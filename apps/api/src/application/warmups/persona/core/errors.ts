/** Base class for everything this project throws on purpose. */
export class WarmupError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** A failure that is worth retrying with backoff (rate limit, capacity, transient network). */
export class RetryableError extends WarmupError {}

/**
 * Any non-success from the Multilogin API. `code` is Multilogin's own error code when
 * the envelope carried one (e.g. 47002 = transient capacity), `status` is the HTTP status.
 */
export class MlxError extends WarmupError {
  constructor(
    message: string,
    readonly details: { status?: number; path?: string; code?: number | string; body?: unknown } = {},
  ) {
    super(message);
  }
  get status(): number | undefined {
    return this.details.status;
  }
  get code(): number | string | undefined {
    return this.details.code;
  }
  /** HTTP 400/401 — drives the plaintext→MD5 sign-in retry. */
  get credentialsRejected(): boolean {
    return this.details.status === 400 || this.details.status === 401;
  }
  /** HTTP 501 or a non-JSON body on a known route: the tier doesn't implement this endpoint. */
  get endpointUnavailable(): boolean {
    return this.details.status === 501 || this.details.code === "NON_JSON";
  }
  get retryable(): boolean {
    const s = this.details.status ?? 0;
    return s === 429 || s >= 500 || this.details.code === 47002;
  }
}

export class MlxAuthError extends MlxError {}

/** Browser/phone driver failures (navigation, CDP, ADB). */
export class DriverError extends WarmupError {}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
