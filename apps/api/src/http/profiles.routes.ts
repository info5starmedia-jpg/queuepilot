import type { FastifyInstance } from "fastify";
import { CreateProfileInputSchema, UpdateProfileInputSchema } from "@queuepilot/contracts";
import type { ProfileService } from "../application/profiles/profile.service.js";

export function registerProfileRoutes(app: FastifyInstance, service: ProfileService): void {
  app.get("/profiles", async (req) => {
    const q = req.query as { group?: string; query?: string };
    const filter: { group?: string; query?: string } = {};
    if (q.group !== undefined) filter.group = q.group;
    if (q.query !== undefined) filter.query = q.query;
    return { profiles: service.list(filter) };
  });

  app.post("/profiles", async (req, reply) => {
    const input = CreateProfileInputSchema.parse(req.body);
    const profile = service.create(input);
    return reply.code(201).send(profile);
  });

  app.get("/profiles/:id", async (req) => {
    const { id } = req.params as { id: string };
    return service.get(id);
  });

  app.patch("/profiles/:id", async (req) => {
    const { id } = req.params as { id: string };
    const input = UpdateProfileInputSchema.parse(req.body);
    return service.update(id, input);
  });

  app.post("/profiles/:id/fingerprint/regenerate", async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { platform?: "windows" | "macos" | "linux" };
    return service.regenerateFingerprint(id, body.platform);
  });

  app.delete("/profiles/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    service.delete(id);
    return reply.code(204).send();
  });
}
