import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { TabCommandService } from "../application/tabs/tab-commands.js";
import { logNote } from "../application/tabs/tab-commands.js";

/**
 * J3b tab workflow commands.
 *   POST /profiles/:id/tabs/change-url      { items:[{tabId,url}], focusDelayMs?, delayMs? }
 *   POST /profiles/:id/tabs/reload-sequence { tabIds, hard?, delayMs?, focusDelayMs? }
 *   POST /profiles/:id/tabs/reopen          { max? }  reopen the last closed tab
 *   POST /tabs/export                       { profileIds }  CSV of open tabs
 *   POST /profiles/:id/log-note             { note }  append to <dataDir>/notes-log.csv
 */
const delay = z.number().int().min(0).max(120_000).default(0);
// -1 = don't bring the tab to the front at all.
const focusDelay = z.number().int().min(-1).max(60_000).default(-1);

export function registerTabCommandRoutes(
  app: FastifyInstance,
  deps: {
    commands: TabCommandService;
    reopen: (profileId: string, max: number) => Promise<unknown>;
    profile: (id: string) => { id: string; name: string; email: string | null };
    dataDir: string;
  },
): void {
  const idOf = (req: { params: unknown }) => (req.params as { id: string }).id;
  app.post("/profiles/:id/tabs/change-url", async (req) => {
    const b = z
      .object({
        items: z.array(z.object({ tabId: z.string().uuid(), url: z.string().url().max(4000) })).min(1).max(200),
        focusDelayMs: focusDelay,
        delayMs: delay,
      })
      .strict()
      .parse(req.body ?? {});
    return { results: await deps.commands.changeUrl(idOf(req), b.items, { focusDelayMs: b.focusDelayMs, delayMs: b.delayMs }) };
  });
  app.post("/profiles/:id/tabs/reload-sequence", async (req) => {
    const b = z
      .object({ tabIds: z.array(z.string().uuid()).min(1).max(200), hard: z.boolean().default(false), delayMs: delay, focusDelayMs: focusDelay })
      .strict()
      .parse(req.body ?? {});
    return { results: await deps.commands.reloadSequence(idOf(req), b.tabIds, { hard: b.hard, delayMs: b.delayMs, focusDelayMs: b.focusDelayMs }) };
  });
  app.post("/profiles/:id/tabs/reopen", async (req) => {
    const { max } = z.object({ max: z.number().int().min(1).max(50).default(10) }).strict().parse(req.body ?? {});
    return { tab: await deps.reopen(idOf(req), max) };
  });
  app.post("/tabs/export", async (req, reply) => {
    const { profileIds } = z.object({ profileIds: z.array(z.string().uuid()).min(1).max(1000) }).strict().parse(req.body ?? {});
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", 'attachment; filename="open-tabs.csv"')
      .send(deps.commands.exportTabs(profileIds.map((id) => deps.profile(id))));
  });
  app.post("/profiles/:id/log-note", async (req) => {
    const { note } = z.object({ note: z.string().min(1).max(2000) }).strict().parse(req.body ?? {});
    const p = deps.profile(idOf(req));
    logNote(deps.dataDir, { profile: p.name, email: p.email, note });
    return { logged: true };
  });
}
