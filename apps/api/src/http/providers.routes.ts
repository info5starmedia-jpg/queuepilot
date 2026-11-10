import type { FastifyInstance } from "fastify";
import {
  CreateProfileProviderInputSchema,
  CreateProxyProviderInputSchema,
} from "@queuepilot/contracts";
import type {
  ProfileProviderService,
  ProxyProviderService,
} from "../application/providers/provider.service.js";

/**
 * Provider routes. Creating a provider validates its source and performs the
 * first import immediately — a provider that can't be read doesn't exist.
 */
export function registerProviderRoutes(
  app: FastifyInstance,
  profileProviders: ProfileProviderService,
  proxyProviders: ProxyProviderService,
): void {
  app.get("/profile-providers", async () => ({
    providers: profileProviders.list(),
  }));

  app.post("/profile-providers", async (req, reply) => {
    const input = CreateProfileProviderInputSchema.parse(req.body);
    return reply.code(201).send(await profileProviders.create(input));
  });

  app.get("/profile-providers/:id", async (req) => {
    const { id } = req.params as { id: string };
    return profileProviders.get(id);
  });

  app.post("/profile-providers/:id/refresh", async (req) => {
    const { id } = req.params as { id: string };
    return profileProviders.refresh(id);
  });

  app.delete("/profile-providers/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    profileProviders.delete(id);
    return reply.code(204).send();
  });

  app.get("/proxy-providers", async () => ({
    providers: proxyProviders.list(),
  }));

  app.post("/proxy-providers", async (req, reply) => {
    const input = CreateProxyProviderInputSchema.parse(req.body);
    return reply.code(201).send(await proxyProviders.create(input));
  });

  app.get("/proxy-providers/:id", async (req) => {
    const { id } = req.params as { id: string };
    return proxyProviders.get(id);
  });

  app.post("/proxy-providers/:id/refresh", async (req) => {
    const { id } = req.params as { id: string };
    return proxyProviders.refresh(id);
  });

  /** Hand out the next proxy per the provider's distribution mode. */
  app.post("/proxy-providers/:id/next", async (req) => {
    const { id } = req.params as { id: string };
    return { proxy: proxyProviders.next(id) };
  });

  app.delete("/proxy-providers/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    proxyProviders.delete(id);
    return reply.code(204).send();
  });
}
