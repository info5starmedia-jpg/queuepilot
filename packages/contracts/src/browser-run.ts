import { z } from "zod";

/**
 * Browser run contract — the durable record that makes the lifecycle
 * crash-safe. A run row is written BEFORE the engine process is spawned; if
 * the API dies mid-launch, recovery finds the row and reconciles it against
 * real OS processes on next boot.
 */
export const BrowserRunStatusSchema = z.enum([
  "launching",
  "running",
  "stopped",
  "crashed",
]);
export type BrowserRunStatus = z.infer<typeof BrowserRunStatusSchema>;

export const BrowserRunSchema = z.object({
  id: z.string().uuid(),
  profileId: z.string().uuid(),
  status: BrowserRunStatusSchema,
  pid: z.number().int().positive().nullable(),
  /**
   * D-002 anti-PID-reuse token: the OS process start time captured at launch.
   * Boot reconciliation treats "alive PID + different start token" as a reused
   * PID — i.e. dead — rather than adopting a stranger's process.
   */
  processToken: z.string().nullable(),
  debugPort: z.number().int().min(1).max(65535).nullable(),
  wsEndpoint: z.string().nullable(),
  startedAt: z.string().datetime(),
  stoppedAt: z.string().datetime().nullable(),
  lastError: z.string().max(2000).nullable(),
});
export type BrowserRun = z.infer<typeof BrowserRunSchema>;

/** Lifecycle event published on the SSE stream. */
export const LifecycleEventSchema = z.object({
  type: z.enum([
    "run.started",
    "run.stopped",
    "run.crashed",
    /** Engine alive but uncommandable (DevTools server wedged); run.degraded latched. */
    "run.degraded",
    /** A degraded engine answered a probe again — flag cleared. */
    "run.healthy",
    "profile.updated",
    "tab.opened",
    "tab.closed",
    /** A configured start page refused to open at launch (detail = url + error). */
    "startpage.failed",
    /** J6 site plug-ins: detail is a short human line (position, timer, event). */
    "queue.position",
    "queue.passed",
    "cart.timer",
    /** 2FA code pipeline outcome (detail = field + site, never the code). */
    "code.resolved",
    "code.failed",
  ]),
  profileId: z.string().uuid(),
  runId: z.string().uuid().nullable(),
  /** Set on tab.opened / tab.closed events. */
  tabId: z.string().uuid().nullish(),
  at: z.string().datetime(),
  detail: z.string().max(500).default(""),
});
export type LifecycleEvent = z.infer<typeof LifecycleEventSchema>;
