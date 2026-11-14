import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { CreateProfileInputSchema, UpdateProfileInputSchema } from "@queuepilot/contracts";
import type { ProfileService } from "../application/profiles/profile.service.js";
import type { ProxyService } from "../application/proxies/proxy.service.js";
import { importProfilesCsv } from "../application/profiles/profile-import.js";

const ImportBodySchema = z.object({
  csv: z.string().min(1).max(2_000_000),
  dryRun: z.boolean().default(false),
  upsert: z.boolean().default(true),
});

export function registerProfileRoutes(
  app: FastifyInstance,
  service: ProfileService,
  proxies: ProxyService,
): void {
  // P6.1: bulk CSV import. Dry-run first, then apply — a bad row never
  // aborts the file.
  app.post("/profiles/import", async (req) => {
    const body = ImportBodySchema.parse(req.body);
    return importProfilesCsv(service, proxies, body.csv, {
      dryRun: body.dryRun,
      upsert: body.upsert,
    });
  });

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
