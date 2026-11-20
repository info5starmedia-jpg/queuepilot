/**
 * Stand-in for mlx-warmup's config module inside QueuePilot. The ported
 * engine only reads WARMUP_PACE (a multiplier on every humanised delay,
 * 0.5–4, default 1.15); Multilogin credentials and the rest do not apply.
 * Env: QP_WARMUP_PACE.
 */
export interface Config {
  WARMUP_PACE: number;
}

export function getConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const n = Number(env.QP_WARMUP_PACE ?? 1.15);
  return { WARMUP_PACE: Number.isFinite(n) ? Math.min(4, Math.max(0.5, n)) : 1.15 };
}
