import Fastify, { type FastifyInstance } from "fastify";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { EngineUpdateService, DEFAULT_MANIFEST_URL } from "./application/engine/engine-update.service.js";
import { createProvider, type ModelProvider } from "./application/agent/provider.js";
import { buildAgentTools } from "./application/agent/agent-tools.js";
import { AgentService } from "./application/agent/agent.service.js";
import { registerAgentRoutes } from "./http/agent.routes.js";
import type { AppConfig } from "./config/config.js";
import { createApiLogger } from "./http/logger.js";
import { registerScriptingOriginDeny } from "./http/scripting-origin-deny.js";
import type { ProfileService } from "./application/profiles/profile.service.js";
import type { ProxyService } from "./application/proxies/proxy.service.js";
import type { BrowserLifecycleService } from "./application/lifecycle/browser.lifecycle.service.js";
import type { EngineHealthService } from "./application/engine/engine-health.service.js";
import type {
  ProfileProviderService,
  ProxyProviderService,
} from "./application/providers/provider.service.js";
import { toHttpError } from "./http/error-mapper.js";
import { scriptingGate } from "./http/scripting-gate.js";
import { registerProfileRoutes } from "./http/profiles.routes.js";
import { registerProxyRoutes } from "./http/proxies.routes.js";
import { registerEmailAccountRoutes } from "./http/email-accounts.routes.js";
import type { EmailAccountService } from "./application/email/email-account.service.js";
import { registerRunRoutes } from "./http/runs.routes.js";
import { registerAdsPowerRoutes } from "./http/adspower.routes.js";
import { registerEventRoutes } from "./http/events.routes.js";
import { registerProviderRoutes } from "./http/providers.routes.js";
import { registerEngineRoutes } from "./http/engine.routes.js";
import { registerTabRoutes } from "./http/tabs.routes.js";
import { registerWarmupRoutes } from "./http/warmups.routes.js";
import { WarmupService } from "./application/warmups/warmup.service.js";
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
import type { SecretStore } from "./application/secrets/secret-store.js";
import { WindowTilingService } from "./application/windows/window-tiling.service.js";
import { registerWindowRoutes } from "./http/windows.routes.js";
import { registerTeamRoutes } from "./http/team.routes.js";

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
  /** C1 engine updates; built from config + settings when absent. */
  engineUpdate?: EngineUpdateService;
  /** P9: model provider override (tests inject a scripted fake). */
  agentProvider?: () => ModelProvider;
  secrets?: SecretStore;
  /** Email accounts for the IMAP resolver (Settings → Integrations). */
  emailAccounts?: EmailAccountService;
}

/**
 * C1 engine updates. Manifest source, resolved per check: Settings → Engine
 * → Update server URL (the owner's server), else SPECTRA_ENGINE_MANIFEST,
 * else the repo's raw manifest. Consent is the existing Settings → Engine
 * switch; no settings store = no consent.
 */
export function engineUpdateServiceFor(config: AppConfig, settings?: SettingsService): EngineUpdateService {
  return new EngineUpdateService({
    enginesDir: path.join(config.dataDir, "engines"),
    manifestRef: () => settings?.get("engine").updateUrl || config.engineManifest || DEFAULT_MANIFEST_URL,
    consent: () => settings?.get("engine").downloadConsent === true,
  });
}

/** `/` and `/dashboard/<flat file>` — exactly what dashboard.routes serves. */
function isDashboardAsset(url: string): boolean {
  const path = url.split("?")[0] ?? url;
  return path === "/" || /^\/dashboard\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(path);
}

export function buildApp(deps: AppDeps): FastifyInstance {
  // Audit GPT-5.4 finding 3: structured logging was off (`logger: false`),
  // so field failures left no trace. pino + reqIds + counters now; tests
  // keep silent logs via NODE_ENV=test.
  const apiLogger = createApiLogger({ silent: process.env.NODE_ENV === "test" });
  const app = Fastify({
    logger: apiLogger.fastifyOptions,
    genReqId: () => apiLogger.nextReqId(),
  });

  app.addHook("onResponse", async (req, reply) => {
    const c = apiLogger.counters;
    c.requestsTotal++;
    if (reply.statusCode >= 500) {
      c.errorsTotal++;
      c.status5xx++;
      apiLogger.pino.warn({ reqId: req.id, url: req.url, status: reply.statusCode }, "request failed");
    } else if (reply.statusCode >= 400) {
      c.status4xx++;
    } else {
      c.status2xx++;
    }
  });

  registerScriptingOriginDeny(app);

  if (deps.config.apiToken) {
    const token = deps.config.apiToken;
    const expected = Buffer.from(`Bearer ${token}`, "utf8");
    app.addHook("onRequest", async (req, reply) => {
      if (req.url === "/health") return;
      // P9 Task 0: the dashboard's static files (HTML/JS/CSS, no data) load
      // without the token so the page can show its sign-in; every API route
      // the page then calls still requires the Bearer token below.
      if (req.method === "GET" && isDashboardAsset(req.url)) return;
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
  app.get("/metrics", async () => ({
    ...apiLogger.snapshot(),
    ...deps.lifecycle.recoveryCounters, // D-002: adopted / unverified / crashed at recovery
  }));

  registerProfileRoutes(app, deps.profiles, deps.proxies, deps.lifecycle, deps.totp, deps.proxyProviders);
  registerProxyRoutes(app, deps.proxies);
  if (deps.emailAccounts) registerEmailAccountRoutes(app, deps.emailAccounts);
  registerRunRoutes(app, deps.lifecycle, deps.profiles, deps.secrets);
  registerWindowRoutes(app, new WindowTilingService(deps.lifecycle, deps.profiles));
  registerAdsPowerRoutes(app, deps.lifecycle, deps.profiles);
  registerEventRoutes(app, deps.lifecycle);
  registerProviderRoutes(app, deps.profileProviders, deps.proxyProviders);
  const engineUpdate = deps.engineUpdate ?? engineUpdateServiceFor(deps.config, deps.settingsStore);
  registerEngineRoutes(app, deps.engineHealth, engineUpdate);
  registerTabRoutes(app, deps.lifecycle);
  const warmups = new WarmupService(deps.lifecycle, deps.config.dataDir);
  registerWarmupRoutes(app, warmups);
  if (deps.plugins) {
    // P9 local agent: tools call these same services in-process.
    const providerFor =
      deps.agentProvider ??
      (() => {
        const s = deps.settingsStore?.get("agent");
        return createProvider({ kind: "ollama", url: s?.providerUrl ?? "http://127.0.0.1:11434", model: s?.model ?? "qwen2.5:7b-instruct" });
      });
    const tools = buildAgentTools({
      profiles: deps.profiles,
      proxies: deps.proxies,
      lifecycle: deps.lifecycle,
      warmups,
      plugins: deps.plugins,
      engineUpdate,
      assertScriptingEnabled: scriptingGate(deps.settingsStore, { hasApiToken: Boolean(deps.config.apiToken) }),
    });
    registerAgentRoutes(app, new AgentService(deps.config.dataDir, tools, providerFor), providerFor);
  }
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
      assertScriptingEnabled: scriptingGate(deps.settingsStore, {
        hasApiToken: Boolean(deps.config.apiToken),
      }),
    });
  }
  if (deps.jyl) {
    registerJylRoutes(app, {
      jyl: deps.jyl,
      assertScriptingEnabled: scriptingGate(deps.settingsStore, {
        hasApiToken: Boolean(deps.config.apiToken),
      }),
    });
  }
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
    registerSettingsSectionRoutes(app, {
      store: deps.settingsStore,
      hasApiToken: Boolean(deps.config.apiToken),
    });
    registerTeamRoutes(app, { settings: deps.settingsStore });
  }

  return app;
}
