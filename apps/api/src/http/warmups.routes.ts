import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { WarmupService } from "../application/warmups/warmup.service.js";

const RecordBodySchema = z.object({
  name: z.string().min(1).max(120),
  /** Recording window. Capped — a record call holds its request open. */
  durationMs: z.number().int().min(500).max(600_000),
  sampleIntervalMs: z.number().int().min(100).max(10_000).default(2000),
});

const CreateBodySchema = z.object({
  name: z.string().min(1).max(120),
  steps: z
    .array(
      z.object({
        url: z.string().url().max(4000),
        dwellMs: z.number().int().min(0).max(3_600_000),
      }),
    )
    .min(1)
    .max(200),
});

const RunBodySchema = z.object({
  profileId: z.string().uuid(),
  stopAfter: z.boolean().default(false),
});

/**
 * Warmup recipes (P3, v0.16.0): record a live browsing session as a replayable
 * URL+dwell recipe, replay it later for cookie warming / trust building.
 */
export function registerWarmupRoutes(app: FastifyInstance, warmups: WarmupService): void {
  app.get("/warmups", async () => ({ recipes: warmups.list() }));

  app.post("/warmups", async (req, reply) => {
    const body = CreateBodySchema.parse(req.body);
    return reply.code(201).send(warmups.create(body.name, body.steps));
  });

  app.get("/warmups/:id", async (req) => {
    const { id } = req.params as { id: string };
    return warmups.get(id);
  });

  app.delete("/warmups/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    warmups.delete(id);
    return reply.code(204).send();
  });

  // Record a RUNNING profile for a bounded window; returns the saved recipe.
  app.post("/profiles/:id/warmup/record", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = RecordBodySchema.parse(req.body);
    const recipe = await warmups.record(id, body.name, body.durationMs, body.sampleIntervalMs);
    return reply.code(201).send(recipe);
  });

  // Replay a recipe on any profile (starts it if idle, leaves it running
  // unless stopAfter).
  app.post("/warmups/:id/run", async (req) => {
    const { id } = req.params as { id: string };
    const body = RunBodySchema.parse(req.body);
    return warmups.run(id, body.profileId, { stopAfter: body.stopAfter });
  });
}

/**
 * W — persona warmups with the owner's engine (PersonaWarmupService).
 *   GET  /warmups/personas                 → available personas
 *   POST /profiles/:id/warmup/persona      → { persona?, sessions?, keepRunning? } starts in background
 *   GET  /profiles/:id/warmup/persona      → latest status for the profile
 */
export function registerPersonaWarmupRoutes(
  app: FastifyInstance,
  svc: import("../application/warmups/persona-warmup.service.js").PersonaWarmupService,
): void {
  app.get("/warmups/personas", async () => ({
    personas: svc.personas().map((p) => ({ id: p.id, name: p.name, description: p.description ?? null, sites: p.sites.length })),
  }));
  // Site settings: every site the persona ships with (and whether it is
  // excluded), plus the operator's added sites.
  app.get("/warmups/personas/:id/sites", async (req) => {
    const { id } = req.params as { id: string };
    const settings = svc.siteSettings(id);
    const base = svc.basePersonas().find((p) => p.id === id)!;
    const host = (u: string) => new URL(u).hostname.toLowerCase().replace(/^www\./, "");
    const skip = new Set(settings.excluded.map((h) => h.toLowerCase().replace(/^www\./, "")));
    const row = (s: { url: string; category: string }, pool: string) => ({ url: s.url, host: host(s.url), category: s.category, pool, excluded: skip.has(host(s.url)) });
    return {
      sites: [...base.sites.map((s) => row(s, "main")), ...base.extraSites.map((s) => row(s, "extra"))],
      added: settings.added,
      excluded: settings.excluded,
    };
  });
  app.put("/warmups/personas/:id/sites", async (req) => {
    const { id } = req.params as { id: string };
    return svc.setSiteSettings(id, req.body ?? {});
  });
  app.post("/profiles/:id/warmup/persona", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { persona?: unknown; sessions?: unknown; keepRunning?: unknown };
    const opts = {
      ...(typeof body.persona === "string" ? { persona: body.persona } : {}),
      ...(typeof body.sessions === "number" ? { sessions: body.sessions } : {}),
      ...(typeof body.keepRunning === "boolean" ? { keepRunning: body.keepRunning } : {}),
    };
    return reply.code(202).send(svc.start(id, opts));
  });
  app.get("/profiles/:id/warmup/persona", async (req) => {
    const { id } = req.params as { id: string };
    return { status: svc.statusOf(id) };
  });
}
