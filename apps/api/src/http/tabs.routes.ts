import type { FastifyInstance } from "fastify";
import { OpenTabInputSchema } from "@queuepilot/contracts";
import type { BrowserLifecycleService } from "../application/lifecycle/browser.lifecycle.service.js";

/**
 * Tab & partition routes (native API). Tabs belong to the profile's ACTIVE
 * run: open with `relatedTo` to share the parent tab's session partition,
 * without it for an isolated session. All tab state is in-memory and dies
 * with the run.
 */
export function registerTabRoutes(
  app: FastifyInstance,
  lifecycle: BrowserLifecycleService,
): void {
  app.post("/profiles/:id/tabs", async (req, reply) => {
    const { id } = req.params as { id: string };
    const input = OpenTabInputSchema.parse(req.body ?? {});
    const tab = await lifecycle.openTab(id, input);
    return reply.code(201).send(tab);
  });

  app.get("/profiles/:id/tabs", async (req) => {
    const { id } = req.params as { id: string };
    return lifecycle.listTabs(id);
  });

  app.post("/profiles/:id/tabs/:tabId/close", async (req) => {
    const { id, tabId } = req.params as { id: string; tabId: string };
    const tab = await lifecycle.closeTab(id, tabId);
    return { closed: tab.status === "closed", tab };
  });
}
