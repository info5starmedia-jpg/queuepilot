import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import { timingSafeEqual } from "node:crypto";
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
import { registerAycdRoutes } from "./http/aycd.routes.js";
import type { EmailAccountService } from "./application/email/email-account.service.js";
import { registerRunRoutes } from "./http/runs.routes.js";
import { registerAdsPowerRoutes } from "./http/adspower.routes.js";
import { registerEventRoutes } from "./http/events.routes.js";
import { registerProviderRoutes } from "./http/providers.routes.js";
import { registerEngineRoutes } from "./http/engine.routes.js";
import { registerTabRoutes } from "./http/tabs.routes.js";
import { registerTabStateRoutes } from "./http/tab-state.routes.js";
import { registerSiteRoutes } from "./http/sites.routes.js";
import { registerDeckRoutes } from "./http/deck.routes.js";
import type { DeckService } from "./application/deck/deck.service.js";
import type { SitePluginService } from "./application/siteplugins/site-plugin.service.js";
import type { DiscordService } from "./application/discord/discord.service.js";
import type { TabStateService } from "./application/tabs/tab-state.service.js";
import { registerWarmupRoutes, registerPersonaWarmupRoutes } from "./http/warmups.routes.js";
import { TeamServerClient } from "./application/team/team-client.js";
import { PersonaWarmupService, ipApiCountry, personaDirsFor } from "./application/warmups/persona-warmup.service.js";
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
  /** AYCD Inbox key check (registerAycdResolver). Absent = no AYCD routes. */
  aycdVerify?: (key: string) => Promise<{ ok: boolean; error: string | null }>;
  jyl?: JylRegistry;
  extensions?: ExtensionRegistry;
  totp?: TotpService;
  settingsStore?: SettingsService;
  secrets?: SecretStore;
  /** Email accounts for the IMAP resolver (Settings → Integrations). */
  emailAccounts?: EmailAccountService;
  /** J3a: tab state per profile + cross-run Tab View. */
  tabState?: TabStateService;
  /** J6: site readers (queue position, cart timer…) and Discord. */
  sites?: SitePluginService;
  discord?: DiscordService;
  /** ADR-0008 Profile Deck. */
  deck?: DeckService;
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
  if (deps.tabState) registerTabStateRoutes(app, deps.tabState);
  if (deps.aliases && deps.aycdVerify) {
    registerAycdRoutes(app, { aliases: deps.aliases, verify: deps.aycdVerify });
  }
  registerRunRoutes(app, deps.lifecycle, deps.profiles, deps.secrets);
  registerWindowRoutes(app, new WindowTilingService(deps.lifecycle, deps.profiles));
  registerAdsPowerRoutes(app, deps.lifecycle, deps.profiles);
  registerEventRoutes(app, deps.lifecycle);
  registerProviderRoutes(app, deps.profileProviders, deps.proxyProviders);
  registerEngineRoutes(app, deps.engineHealth);
  registerTabRoutes(app, deps.lifecycle);
  registerWarmupRoutes(app, new WarmupService(deps.lifecycle, deps.config.dataDir));
  registerPersonaWarmupRoutes(
    app,
    new PersonaWarmupService({
      lifecycle: deps.lifecycle,
      exitCountry: (profileId: string) =>
        ipApiCountry(deps.lifecycle.egressDiagnostics(profileId)?.egress?.exitIp ?? null),
      personaDirs: personaDirsFor(deps.config.dataDir, path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")),
      siteSettingsFile: path.join(deps.config.dataDir, "persona-sites.json"),
      // W2: with a team server configured, personas, site settings and plans
      // come from it; the local planner is only the no-server fallback.
      remote: () => (deps.settingsStore ? TeamServerClient.fromSettings(deps.settingsStore.get("team")) : null),
    }),
  );
  // LIC: which licence the configured team key belongs to, and days left.
  // { configured: false } without a team server; server errors (expired,
  // revoked, unreachable) come back as { configured: true, error }.
  app.get("/team/licence", async () => {
    const client = deps.settingsStore ? TeamServerClient.fromSettings(deps.settingsStore.get("team")) : null;
    if (!client) return { configured: false };
    try {
      return { configured: true, licence: await client.licence() };
    } catch (err) {
      const e = err as { code?: string; message?: string };
      return { configured: true, error: { code: e.code ?? "HTTP_ERROR", message: e.message ?? String(err) } };
    }
  });
  registerCookieRoutes(app, deps.lifecycle, {
    // Audit A5: raw cookie values only on installs that explicitly set a
    // token — that choice is the operator's opt-in to raw export.
    rawCookieExportAllowed: Boolean(deps.config.apiToken),
  });
  registerSiteRoutes(app, {
    ...(deps.sites ? { sites: deps.sites } : {}),
    ...(deps.discord ? { discord: deps.discord } : {}),
    lifecycle: deps.lifecycle,
    rawCookieExportAllowed: Boolean(deps.config.apiToken),
    profileName: (id) => deps.profiles.get(id).name,
    proxyName: (id) => {
      const proxyId = deps.profiles.get(id).proxyId;
      if (!proxyId) return null;
      try {
        return deps.proxies.get(proxyId).name;
      } catch {
        return null;
      }
    },
  });
  if (deps.deck) {
    registerDeckRoutes(app, {
      deck: deps.deck,
      running: () =>
        deps.profiles
          .list()
          .filter((p) => p.status === "running")
          .map((p) => ({ id: p.id, pid: deps.lifecycle.activeRun(p.id)?.pid ?? null })),
    });
  }
  registerGoogleRoutes(app, deps.google);
  registerDashboardRoutes(app);
  if (deps.bundles) registerBundleRoutes(app, deps.bundles);
  if (deps.plugins && deps.resolvers && deps.parsers && deps.aliases) {
    const tabState = deps.tabState;
    registerPluginRoutes(app, {
      // J3a/J6: a resolved CODE is kept in tab state and announced (never its value).
      onCode: (profileId, field, value, isError, site) => {
        const kind = field === "emailcode" ? "emailCode" : field === "smscode" ? "smsCode" : "otherCode";
        tabState?.recordCode(profileId, kind, { value, timestamp: new Date().toISOString(), isError });
        deps.lifecycle.events.emit("lifecycle", {
          type: isError ? "code.failed" : "code.resolved",
          profileId,
          runId: deps.lifecycle.activeRun(profileId)?.id ?? null,
          at: new Date().toISOString(),
          detail: `${field}${site ? ` · ${site}` : ""}`,
        });
      },
      plugins: deps.plugins,
      resolvers: deps.resolvers,
      parsers: deps.parsers,
      aliases: deps.aliases,
      profiles: deps.profiles,
      assertScriptingEnabled: scriptingGate(deps.settingsStore, {
        hasApiToken: Boolean(deps.config.apiToken),
      }),
      hasApiToken: Boolean(deps.config.apiToken),
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
  }

  return app;
}
