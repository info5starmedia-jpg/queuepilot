import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { OpenTabInputSchema, type BrowserTab } from "@queuepilot/contracts";
import type { BrowserLifecycleService } from "../application/lifecycle/browser.lifecycle.service.js";
import { filterTabs } from "../application/tabs/tab-thinger.js";

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

  /**
   * Tab Thinger: run a formula query over the profile's tabs. Empty query
   * = all tabs. Unknown fields refuse with VALIDATION_FAILED — a typo'd
   * query must never silently match everything.
   */
  app.post("/profiles/:id/tabs/query", async (req) => {
    const { id } = req.params as { id: string };
    const { q } = z.object({ q: z.string().max(500).default("") }).parse(req.body ?? {});
    return { tabs: filterTabs(lifecycle.listTabs(id).tabs, q) };
  });

  /**
   * Mass select → command: close an explicit set of tabs or every tab a
   * Thinger query matches. Per-tab results; an already-closed tab reports
   * closed:true (closes are idempotent), a failed tab reports its error
   * and never aborts the rest of the set.
   */
  app.post("/profiles/:id/tabs/bulk-close", async (req) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({
        tabIds: z.array(z.string().uuid()).max(500).optional(),
        q: z.string().max(500).optional(),
      })
      .refine((v) => v.tabIds !== undefined || v.q !== undefined, {
        message: "tabIds or q is required",
      })
      .parse(req.body ?? {});

    let targets: BrowserTab[];
    if (body.tabIds) {
      const all = lifecycle.listTabs(id).tabs;
      const wanted = new Set(body.tabIds);
      targets = all.filter((t) => wanted.has(t.id));
    } else {
      targets = filterTabs(lifecycle.listTabs(id).tabs, body.q!);
    }

    const results: { tabId: string; closed: boolean; error?: string }[] = [];
    for (const tab of targets) {
      try {
        const closed = await lifecycle.closeTab(id, tab.id);
        results.push({ tabId: tab.id, closed: closed.status === "closed" });
      } catch (err) {
        results.push({
          tabId: tab.id,
          closed: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { total: targets.length, results };
  });

  /**
   * Bulk-open: open many URLs at once (optionally all related to one tab's
   * partition). Opens sequentially in request order; one bad URL reports
   * its error and the rest still open.
   */
  app.post("/profiles/:id/tabs/bulk-open", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({
        urls: z.array(z.string().url().max(4000)).min(1).max(100),
        relatedTo: z.string().uuid().nullish(),
      })
      .parse(req.body ?? {});

    const results: { url: string; tab: BrowserTab | null; error?: string }[] = [];
    for (const url of body.urls) {
      try {
        const tab = await lifecycle.openTab(id, { url, relatedTo: body.relatedTo ?? null });
        results.push({ url, tab });
      } catch (err) {
        results.push({
          url,
          tab: null,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return reply.code(201).send({ total: results.length, results });
  });
}
