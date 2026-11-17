import pino, { type Logger } from "pino";

/**
 * Audit GPT-5.4 finding 3: the API ran with `logger: false`, so a failure
 * in the field produced no trace at all. This module wires pino through
 * Fastify and adds:
 *
 * - request IDs (reqId) — every log line and the X-Request-Id response
 *   header carry the same id, so a dashboard action can be traced through
 *   the log file;
 * - in-process counters + a GET /metrics snapshot — enough to answer
 *   "is the API healthy and how many errors is it throwing" without an
 *   external metrics stack;
 * - level control via SPECTRA_LOG_LEVEL (default info; `silent` disables).
 *
 * Tests build the same app: they pass loggerSilent so vitest output is not
 * flooded, while production gets structured logs by default.
 */

export interface ApiLogger {
  /** Options object handed to Fastify (it builds its own pino instance —
   *  passing a pino v10 instance into fastify 5's factory trips a version
   *  guard, so we give it the config shape instead). */
  fastifyOptions: { level: string; base: Record<string, string>; timestamp: () => string };
  /** Standalone logger for module-level log lines (metrics warnings, boot). */
  pino: Logger;
  /** reqId seed for Fastify's genReqId. */
  nextReqId: () => string;
  counters: {
    requestsTotal: number;
    errorsTotal: number;
    status2xx: number;
    status4xx: number;
    status5xx: number;
  };
  snapshot: () => Record<string, unknown>;
}

export function createApiLogger(opts: { silent?: boolean } = {}): ApiLogger {
  const level = opts.silent
    ? "silent"
    : (process.env.SPECTRA_LOG_LEVEL ?? "info");
  const base = { service: "queuepilot-api" };
  const timestamp = pino.stdTimeFunctions.isoTime;
  const counters = { requestsTotal: 0, errorsTotal: 0, status2xx: 0, status4xx: 0, status5xx: 0 };
  let seq = 0;
  return {
    fastifyOptions: { level, base, timestamp },
    pino: pino({ level, base, timestamp }),
    nextReqId: () => `req-${Date.now().toString(36)}-${(seq = (seq + 1) % 0xffff).toString(16)}`,
    counters,
    snapshot: () => ({ ...counters, logLevel: level }),
  };
}
