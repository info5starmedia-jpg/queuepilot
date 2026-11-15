import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { DomainError, ErrorCodes } from "@queuepilot/contracts";
import type { BrowserLifecycleService } from "../application/lifecycle/browser.lifecycle.service.js";
import {
  clearCookies,
  listCookies,
  setCookie,
} from "../application/cookies/cookie-thinger.js";

/**
 * Cookie Thinger routes — programmable cookie surgery on a running profile.
 * `partitionId` scopes every op to that session partition (via its open
 * tabs' browser contexts); without it the op covers the whole run.
 */

const FilterSchema = z.object({
  domain: z.string().max(300).optional(),
  name: z.string().max(300).optional(),
  partitionId: z.string().uuid().optional(),
  /**
   * v0.15.0 (audit A5): values are REDACTED by default. `reveal=raw` returns
   * full values but only works when the install runs with SPECTRA_API_TOKEN
   * set — the explicit opt-in that says "this operator accepts the risk".
   */
  reveal: z.enum(["raw"]).optional(),
});

const SetCookieBodySchema = z
  .object({
    name: z.string().min(1).max(300),
    value: z.string().max(8000),
    domain: z.string().min(1).max(300),
    path: z.string().max(300).optional(),
    expires: z.number().int().min(0).optional(),
    secure: z.boolean().optional(),
    httpOnly: z.boolean().optional(),
    partitionId: z.string().uuid().optional(),
  })
  .strict();

export function registerCookieRoutes(
  app: FastifyInstance,
  lifecycle: BrowserLifecycleService,
  opts: { rawCookieExportAllowed: boolean } = { rawCookieExportAllowed: false },
): void {
  function requireRunning(profileId: string) {
    const run = lifecycle.activeRun(profileId);
    if (!run || run.status !== "running" || !run.wsEndpoint) {
      throw new DomainError(
        ErrorCodes.PROFILE_NOT_RUNNING,
        `profile ${profileId} is not running — start it before cookie surgery`,
      );
    }
    return run.wsEndpoint;
  }

  /** Engine tab ids of every OPEN tab in the partition (empty = unknown). */
  function partitionTabIds(profileId: string, partitionId?: string): Set<string> | undefined {
    if (!partitionId) return undefined;
    const ids = lifecycle
      .listTabs(profileId)
      .tabs.filter((t) => t.partitionId === partitionId && t.status === "open" && t.engineTabId)
      .map((t) => t.engineTabId!);
    if (ids.length === 0) {
      throw new DomainError(
        ErrorCodes.CONFLICT,
        `partition ${partitionId} has no open tabs to operate through — open a tab there first`,
      );
    }
    return new Set(ids);
  }

  app.get("/profiles/:id/cookies", async (req) => {
    const { id } = req.params as { id: string };
    const wsEndpoint = requireRunning(id);
    const q = FilterSchema.parse(req.query ?? {});
    const engineTabIds = partitionTabIds(id, q.partitionId);
    const cookies = await listCookies(wsEndpoint, q, { engineTabIds });
    // Audit A5 (v0.15.0): full values are session-theft material — the
    // default list is redacted; raw values need the explicit opt-in.
    if (q.reveal === "raw") {
      if (!opts.rawCookieExportAllowed) {
        throw new DomainError(
          ErrorCodes.FORBIDDEN,
          "raw cookie export requires SPECTRA_API_TOKEN to be configured on this install",
        );
      }
      return { cookies, total: cookies.length, revealed: true };
    }
    return {
      cookies: cookies.map((c) => ({ ...c, value: "***" })),
      total: cookies.length,
      revealed: false,
    };
  });

  app.post("/profiles/:id/cookies", async (req, reply) => {
    const { id } = req.params as { id: string };
    const wsEndpoint = requireRunning(id);
    const body = SetCookieBodySchema.parse(req.body ?? {});
    const engineTabIds = partitionTabIds(id, body.partitionId);
    await setCookie(wsEndpoint, body, { engineTabId: [...(engineTabIds ?? [])][0] });
    return reply.code(201).send({ set: true, partitionScoped: Boolean(body.partitionId) });
  });

  /**
   * Bulk load: set many cookies at once, optionally scoped to one session
   * partition (through its open tabs' browser contexts — the partition's
   * own store is what receives them). Per-cookie results; one bad cookie
   * reports its error and the rest still load.
   */
  app.post("/profiles/:id/cookies/load", async (req, reply) => {
    const { id } = req.params as { id: string };
    const wsEndpoint = requireRunning(id);
    const body = z
      .object({
        cookies: z
          .array(SetCookieBodySchema.omit({ partitionId: true }))
          .min(1)
          .max(500),
        partitionId: z.string().uuid().optional(),
      })
      .strict()
      .parse(req.body ?? {});
    const engineTabIds = partitionTabIds(id, body.partitionId);
    const engineTabId = [...(engineTabIds ?? [])][0];

    const results: { index: number; name: string; set: boolean; error?: string }[] = [];
    for (const [index, cookie] of body.cookies.entries()) {
      try {
        await setCookie(wsEndpoint, cookie, { engineTabId });
        results.push({ index, name: cookie.name, set: true });
      } catch (err) {
        results.push({
          index,
          name: cookie.name,
          set: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const set = results.filter((r) => r.set).length;
    return reply
      .code(201)
      .send({ total: results.length, set, partitionScoped: Boolean(body.partitionId), results });
  });

  app.post("/profiles/:id/cookies/clear", async (req) => {
    const { id } = req.params as { id: string };
    const wsEndpoint = requireRunning(id);
    const body = FilterSchema.extend({
      /** Only meaningful alongside partitionId-less clears; kept for symmetry. */
      all: z.boolean().optional(),
    })
      .strict()
      .refine((v) => v.domain !== undefined || v.name !== undefined, {
        message: "clear needs at least a domain or name filter — refusing to wipe the whole jar",
      })
      .parse(req.body ?? {});
    const engineTabIds = partitionTabIds(id, body.partitionId);
    const matched = await clearCookies(wsEndpoint, body, { engineTabIds });
    return { matched };
  });
}
