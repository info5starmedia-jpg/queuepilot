import Fastify, { type FastifyInstance } from "fastify";
import type { AppConfig } from "./config/config.js";
import type { ProfileService } from "./application/profiles/profile.service.js";
import type { ProxyService } from "./application/proxies/proxy.service.js";
import type { BrowserLifecycleService } from "./application/lifecycle/browser.lifecycle.service.js";
import type { EngineHealthService } from "./application/engine/engine-health.service.js";
import type {
  ProfileProviderService,
  ProxyProviderService,
} from "./application/providers/provider.service.js";
import { toHttpError } from "./http/error-mapper.js";
import { registerProfileRoutes } from "./http/profiles.routes.js";
import { registerProxyRoutes } from "./http/proxies.routes.js";
import { registerRunRoutes } from "./http/runs.routes.js";
import { registerAdsPowerRoutes } from "./http/adspower.routes.js";
import { registerEventRoutes } from "./http/events.routes.js";
import { registerProviderRoutes } from "./http/providers.routes.js";
import { registerEngineRoutes } from "./http/engine.routes.js";
import { registerTabRoutes } from "./http/tabs.routes.js";
import { registerGoogleRoutes } from "./http/google.routes.js";
import type { GoogleAuthService } from "./application/google/google-auth.service.js";

export interface AppDeps {
  config: AppConfig;
  profiles: ProfileService;
  proxies: ProxyService;
  lifecycle: BrowserLifecycleService;
  profileProviders: ProfileProviderService;
  proxyProviders: ProxyProviderService;
  engineHealth: EngineHealthService;
  google: GoogleAuthService;
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: false });

  if (deps.config.apiToken) {
    const token = deps.config.apiToken;
    app.addHook("onRequest", async (req, reply) => {
      if (req.url === "/health") return;
      if (req.headers.authorization !== `Bearer ${token}`) {
        return reply
          .code(401)
          .send({ error: { code: "UNAUTHORIZED", message: "invalid token" } });
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
  registerProviderRoutes(app, deps.profileProviders, deps.proxyProviders);
  registerEngineRoutes(app, deps.engineHealth);
  registerTabRoutes(app, deps.lifecycle);
  registerGoogleRoutes(app, deps.google);

  return app;
}
