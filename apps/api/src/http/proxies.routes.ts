import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { CreateProxyInputSchema, ImportProxiesInputSchema, UpdateProxyInputSchema } from "@queuepilot/contracts";
import type { ProxyService } from "../application/proxies/proxy.service.js";

const GroupName = z.string().trim().min(1).max(120);
const RenameGroupSchema = z.object({ from: GroupName, to: GroupName });
const BatchMoveSchema = z.object({ ids: z.array(z.string().min(1)).min(1).max(1000), group: GroupName });

export function registerProxyRoutes(app: FastifyInstance, service: ProxyService): void {
  app.get("/proxies", async (req) => {
    const { group } = req.query as { group?: string };
    return { proxies: service.list(group || undefined) };
  });

  // Proxy groups (B2) — same model as /profile-groups.
  app.get("/proxy-groups", async () => ({ groups: service.groups() }));
  app.post("/proxy-groups/rename", async (req) => {
    const body = RenameGroupSchema.parse(req.body ?? {});
    return service.renameGroup(body.from, body.to);
  });
  app.post("/proxies/batch-move", async (req) => {
    const body = BatchMoveSchema.parse(req.body ?? {});
    return service.moveToGroup(body.ids, body.group);
  });

  app.post("/proxies", async (req, reply) => {
    const input = CreateProxyInputSchema.parse(req.body);
    return reply.code(201).send(service.create(input));
  });

  // Bulk import: JSON { text, type? }, or a .txt file's bytes as text/plain
  // (`?type=` for the default scheme). Always 200 with a per-line report.
  app.post("/proxies/import", async (req) => {
    const body =
      typeof req.body === "string"
        ? { text: req.body, ...(req.query as { type?: string; group?: string }) }
        : req.body;
    const input = ImportProxiesInputSchema.parse(body);
    return service.importText(input.text, input.type, input.group);
  });

  app.get("/proxies/:id", async (req) => {
    const { id } = req.params as { id: string };
    return service.get(id);
  });

  app.patch("/proxies/:id", async (req) => {
    const { id } = req.params as { id: string };
    const input = UpdateProxyInputSchema.parse(req.body);
    return service.update(id, input);
  });

  app.delete("/proxies/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    service.delete(id);
    return reply.code(204).send();
  });

  app.post("/proxies/:id/test", async (req) => {
    const { id } = req.params as { id: string };
    return service.test(id);
  });

  // Validation history (v0.16.0): every test() lands here, newest first.
  app.get("/proxies/:id/health", async (req) => {
    const { id } = req.params as { id: string };
    const { limit } = req.query as { limit?: string };
    service.get(id); // 404 when the proxy doesn't exist
    return { history: service.healthHistory(id, limit === undefined ? 50 : Number(limit)) };
  });
}
