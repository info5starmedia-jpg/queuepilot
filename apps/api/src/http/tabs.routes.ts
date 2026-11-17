import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { OpenTabInputSchema, type BrowserTab } from "@queuepilot/contracts";
import type { BrowserLifecycleService } from "../application/lifecycle/browser.lifecycle.service.js";
import { DomainError, ErrorCodes } from "@queuepilot/contracts";
import { filterTabs, sortTabs, isTabSortMode, TAB_SORT_MODES } from "../application/tabs/tab-thinger.js";

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
  /**
   * Batch state for the dashboard grid (v0.15.1, audit B4): drift + live tab
   * count for MANY profiles in ONE request. The grid re-renders on every SSE
   * event; per-profile /drift + /tabs made that 2N requests per refresh and
   * fell over past a few dozen running profiles. Per-profile failures are
   * isolated — a bad id yields a null entry, never a failed batch.
   */
  app.post("/profiles/batch-state", async (req) => {
    const { ids } = z
      .object({ ids: z.array(z.string().uuid()).min(1).max(1000) })
      .parse(req.body ?? {});
    const states = ids.map((id) => {
      try {
        const listed = lifecycle.listTabs(id);
        return {
          id,
          drift: lifecycle.identityDrift(id),
          tabCount: listed.tabs.length,
          // Adopted proxied run whose relay died with the old API (D-002).
          relay: lifecycle.relayState(id),
        };
      } catch {
        return { id, drift: null, tabCount: 0, relay: null };
      }
    });
    return { states };
  });

  app.post("/profiles/:id/tabs", async (req, reply) => {
    const { id } = req.params as { id: string };
    const input = OpenTabInputSchema.parse(req.body ?? {});
    const tab = await lifecycle.openTab(id, input);
    return reply.code(201).send(tab);
  });

  app.get("/profiles/:id/tabs", async (req) => {
    const { id } = req.params as { id: string };
    const { sort } = req.query as { sort?: string };
    const listed = lifecycle.listTabs(id);
    if (sort === undefined) return listed;
    if (!isTabSortMode(sort)) {
      throw new DomainError(
        ErrorCodes.VALIDATION_FAILED,
        `unknown tab sort "${sort}" — one of: ${TAB_SORT_MODES.join(", ")}`,
      );
    }
    return { ...listed, tabs: sortTabs(listed.tabs, sort) };
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
    const { q, sort } = z
      .object({
        q: z.string().max(500).default(""),
        sort: z.enum(TAB_SORT_MODES).optional(),
      })
      .parse(req.body ?? {});
    const tabs = filterTabs(lifecycle.listTabs(id).tabs, q);
    return { tabs: sort ? sortTabs(tabs, sort) : tabs };
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
   * partition). Opens sequentially in request order — with `staggerMs`, each
   * open waits that long after the previous one settled, so a hundred-page
   * burst doesn't land on the target as a single thundering herd. One bad
   * URL reports its error and the rest still open.
   */
  app.post("/profiles/:id/tabs/bulk-open", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({
        urls: z.array(z.string().url().max(4000)).min(1).max(100),
        relatedTo: z.string().uuid().nullish(),
        staggerMs: z.number().int().min(0).max(10_000).default(0),
      })
      .parse(req.body ?? {});

    const results: { url: string; tab: BrowserTab | null; error?: string }[] = [];
    for (const [i, url] of body.urls.entries()) {
      if (i > 0 && body.staggerMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, body.staggerMs));
      }
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
