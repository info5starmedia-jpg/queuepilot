import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { TabStateBulkSchema } from "@queuepilot/contracts";
import type { TabStateService } from "../application/tabs/tab-state.service.js";

/**
 * J3a — tab state + the cross-run Tab View.
 *   GET   /tab-view                         running profiles, open tabs, state, Deck label (?all=1: every profile)
 *   GET   /profiles/:id/tab-state           one profile's tab state
 *   PATCH /profiles/:id/tab-state           partial update (data merges; null deletes a key)
 *   POST  /profiles/:id/tab-state/clear-codes
 *   POST  /profiles/:id/tab-state/passcode  takes the first unused passcode (marks it used)
 *   POST  /tab-state/bulk                   one line per tab: passcodes (comma = many) or notes
 *   POST  /tab-state/export                 { profileIds } → CSV
 */
export function registerTabStateRoutes(app: FastifyInstance, svc: TabStateService): void {
  app.get("/tab-view", async (req) => {
    const all = (req.query as { all?: string }).all === "1";
    return { tabs: svc.view({ all }) };
  });
  app.get("/profiles/:id/tab-state", async (req) => svc.get((req.params as { id: string }).id));
  app.patch("/profiles/:id/tab-state", async (req) => svc.patch((req.params as { id: string }).id, req.body ?? {}));
  app.post("/profiles/:id/tab-state/clear-codes", async (req) => svc.clearCodes((req.params as { id: string }).id));
  app.post("/profiles/:id/tab-state/passcode", async (req) => ({ passcode: svc.takePasscode((req.params as { id: string }).id) }));
  app.post("/tab-state/bulk", async (req) => svc.bulk(TabStateBulkSchema.parse(req.body)));
  app.post("/tab-state/export", async (req, reply) => {
    const { profileIds } = z.object({ profileIds: z.array(z.string().uuid()).min(1).max(1000) }).strict().parse(req.body);
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", 'attachment; filename="tabs.csv"')
      .send(svc.exportCsv(profileIds));
  });
}
