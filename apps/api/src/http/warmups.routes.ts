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
