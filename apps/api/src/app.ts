import Fastify, { type FastifyInstance } from "fastify";
import type { AppConfig } from "./config/config.js";
import type { ProfileService } from "./application/profiles/profile.service.js";
import type { ProxyService } from "./application/proxies/proxy.service.js";
import type { BrowserLifecycleService } from "./application/lifecycle/browser.lifecycle.service.js";
import { toHttpError } from "./http/error-mapper.js";
import { registerProfileRoutes } from "./http/profiles.routes.js";
import { registerProxyRoutes } from "./http/proxies.routes.js";
import { registerRunRoutes } from "./http/runs.routes.js";
import { registerAdsPowerRoutes } from "./http/adspower.routes.js";
import { registerEventRoutes } from "./http/events.routes.js";

export interface AppDeps {
  config: AppConfig;
  profiles: ProfileService;
  proxies: ProxyService;
  lifecycle: BrowserLifecycleService;
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: false });

  if (deps.config.apiToken) {
    const token = deps.config.apiToken;
    app.addHook("onRequest", async (req, reply) => {
      if (req.url === "/health") return;
      if (req.headers.authorization !== `Bearer ${token}`) {
        return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "invalid token" } });
      }
    });
  }

  app.setErrorHandler((err, _req, reply) => {
    const { status, body } = toHttpError(err);
    void reply.code(status).send(body);
  });

  app.get("/health", async () => ({ status: "ok", service: "queuepilot" }));

  registerProfileRoutes(app, deps.profiles);
  registerProxyRoutes(app, deps.proxies);
  registerRunRoutes(app, deps.lifecycle);
  registerAdsPowerRoutes(app, deps.lifecycle, deps.profiles);
  registerEventRoutes(app, deps.lifecycle);

  return app;
}
