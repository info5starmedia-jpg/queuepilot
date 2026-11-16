import type { FastifyInstance } from "fastify";
import { CreateProxyInputSchema, UpdateProxyInputSchema } from "@queuepilot/contracts";
import type { ProxyService } from "../application/proxies/proxy.service.js";

export function registerProxyRoutes(app: FastifyInstance, service: ProxyService): void {
  app.get("/proxies", async () => ({ proxies: service.list() }));

  app.post("/proxies", async (req, reply) => {
    const input = CreateProxyInputSchema.parse(req.body);
    return reply.code(201).send(service.create(input));
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
