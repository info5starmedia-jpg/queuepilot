import Fastify, { type FastifyInstance } from "fastify";
import { timingSafeEqual } from "node:crypto";
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
import { registerCookieRoutes } from "./http/cookies.routes.js";
import { registerGoogleRoutes } from "./http/google.routes.js";
import { registerDashboardRoutes } from "./http/dashboard.routes.js";
import { registerBundleRoutes } from "./http/bundle.routes.js";
import type { GoogleAuthService } from "./application/google/google-auth.service.js";
import type { BundleService } from "./application/bundles/bundle.service.js";
import { registerPluginRoutes } from "./http/plugins.routes.js";
import type { PluginRegistry } from "./application/plugins/plugin-registry.js";
import type { ResolverRegistry } from "./application/resolvers/resolver-registry.js";
import type { ParserRegistry } from "./application/parsers/parser-registry.js";
import type { AliasStore } from "./application/resolvers/token-aliases.js";
import type { JylRegistry } from "./application/jyl/jyl-registry.js";
import { registerJylRoutes } from "./http/jyl.routes.js";
import type { ExtensionRegistry } from "./application/extensions/extension-registry.js";
import type { TotpService } from "./application/profiles/totp.service.js";
import { registerExtensionRoutes } from "./http/extensions.routes.js";
import { SettingsBundleService } from "./application/settings/settings-bundle.service.js";
import { registerSettingsRoutes, registerSettingsSectionRoutes } from "./http/settings.routes.js";
import type { SettingsService } from "./application/settings/settings.service.js";
import { WindowTilingService } from "./application/windows/window-tiling.service.js";
import { registerWindowRoutes } from "./http/windows.routes.js";

export interface AppDeps {
  config: AppConfig;
  profiles: ProfileService;
  proxies: ProxyService;
  lifecycle: BrowserLifecycleService;
  profileProviders: ProfileProviderService;
  proxyProviders: ProxyProviderService;
  engineHealth: EngineHealthService;
  google: GoogleAuthService;
  bundles?: BundleService;
  plugins?: PluginRegistry;
  resolvers?: ResolverRegistry;
  parsers?: ParserRegistry;
  aliases?: AliasStore;
  jyl?: JylRegistry;
  extensions?: ExtensionRegistry;
  totp?: TotpService;
  settingsStore?: SettingsService;
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: false });

  if (deps.config.apiToken) {
    const token = deps.config.apiToken;
    const expected = Buffer.from(`Bearer ${token}`, "utf8");
    app.addHook("onRequest", async (req, reply) => {
      if (req.url === "/health") return;
      // Constant-time compare (audit A-rec #1): a plain string !== leaks
      // the token byte-by-byte through response timing.
      const given = Buffer.from(req.headers.authorization ?? "", "utf8");
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
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

  registerProfileRoutes(app, deps.profiles, deps.proxies, deps.lifecycle, deps.totp);
  registerProxyRoutes(app, deps.proxies);
  registerRunRoutes(app, deps.lifecycle, deps.profiles);
  registerWindowRoutes(app, new WindowTilingService(deps.lifecycle, deps.profiles));
  registerAdsPowerRoutes(app, deps.lifecycle, deps.profiles);
  registerEventRoutes(app, deps.lifecycle);
  registerProviderRoutes(app, deps.profileProviders, deps.proxyProviders);
  registerEngineRoutes(app, deps.engineHealth);
  registerTabRoutes(app, deps.lifecycle);
  registerCookieRoutes(app, deps.lifecycle, {
    // Audit A5: raw cookie values only on installs that explicitly set a
    // token — that choice is the operator's opt-in to raw export.
    rawCookieExportAllowed: Boolean(deps.config.apiToken),
  });
  registerGoogleRoutes(app, deps.google);
  registerDashboardRoutes(app);
  if (deps.bundles) registerBundleRoutes(app, deps.bundles);
  if (deps.plugins && deps.resolvers && deps.parsers && deps.aliases) {
    registerPluginRoutes(app, {
      plugins: deps.plugins,
      resolvers: deps.resolvers,
      parsers: deps.parsers,
      aliases: deps.aliases,
      profiles: deps.profiles,
    });
  }
  if (deps.jyl) registerJylRoutes(app, { jyl: deps.jyl });
  if (deps.extensions) registerExtensionRoutes(app, { extensions: deps.extensions });
  if (deps.aliases && deps.plugins) {
    registerSettingsRoutes(app, {
      settings: new SettingsBundleService(
        deps.aliases,
        deps.plugins,
        deps.profileProviders,
        deps.proxyProviders,
      ),
    });
  }
  if (deps.settingsStore) {
    registerSettingsSectionRoutes(app, { store: deps.settingsStore });
  }

  return app;
}
