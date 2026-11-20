import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { DomainError, ErrorCodes } from "@queuepilot/contracts";
import { cdpCookieOps, matchCookieCsv, type CookieOps, type CookieThinger } from "../application/cookies/cookie-thinger-file.js";

/**
 * J5 cookie-thinger file.
 *   GET  /cookie-thinger                     { exists, groups, errors, lists } (counts only)
 *   PUT  /cookie-thinger                     { text }  save (refused if it has errors)
 *   POST /profiles/:id/cookie-thinger/run    { group }
 *   POST /cookie-thinger/run                 { group, profileIds }  one group on many profiles
 *   POST /cookie-thinger/load-csv            { csv }  cookies-for-profiles CSV into running profiles
 * Browser-origin denied; responses never carry cookie values.
 */
export function registerCookieThingerRoutes(
  app: FastifyInstance,
  deps: {
    thinger: CookieThinger;
    ops: (profileId: string) => CookieOps;
    profiles: () => { id: string; name: string; group: string | null; email: string | null }[];
  },
): void {
  const group = z.number().int().min(1).max(10);
  app.get("/cookie-thinger", async () => deps.thinger.status());
  app.put("/cookie-thinger", { bodyLimit: 512 * 1024 }, async (req) => {
    const { text } = z.object({ text: z.string().max(500_000) }).strict().parse(req.body ?? {});
    try {
      return deps.thinger.save(text);
    } catch (e) {
      throw new DomainError(ErrorCodes.VALIDATION_FAILED, e instanceof Error ? e.message : String(e));
    }
  });
  app.post("/profiles/:id/cookie-thinger/run", async (req) => {
    const { group: g } = z.object({ group }).strict().parse(req.body ?? {});
    return deps.thinger.run(g, deps.ops((req.params as { id: string }).id));
  });
  app.post("/cookie-thinger/run", async (req) => {
    const b = z.object({ group, profileIds: z.array(z.string().uuid()).min(1).max(500) }).strict().parse(req.body ?? {});
    const results: { profileId: string; ok: boolean; summary?: unknown; error?: string }[] = [];
    for (const id of b.profileIds) {
      try {
        results.push({ profileId: id, ok: true, summary: await deps.thinger.run(b.group, deps.ops(id)) });
      } catch (e) {
        results.push({ profileId: id, ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return { results };
  });
  app.post("/cookie-thinger/load-csv", { bodyLimit: 8 * 1024 * 1024 }, async (req) => {
    const { csv } = z.object({ csv: z.string().max(8_000_000) }).strict().parse(req.body ?? {});
    const { byProfile, unmatched } = matchCookieCsv(csv, deps.profiles());
    const results: { profileId: string; set: number; error?: string }[] = [];
    for (const [id, cookies] of byProfile) {
      try {
        const ops = deps.ops(id);
        for (const c of cookies) await ops.set(c);
        results.push({ profileId: id, set: cookies.length });
      } catch (e) {
        results.push({ profileId: id, set: 0, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return { unmatched, results };
  });
}

export { cdpCookieOps };
