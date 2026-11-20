import type { Db } from "../src/infrastructure/database.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { openTestDatabase } from "../src/infrastructure/database.js";
import {
  ProfileRepository,
  FingerprintIdentityRepository,
} from "../src/application/profiles/profile.repository.js";
import { ProfileService } from "../src/application/profiles/profile.service.js";
import { ProxyRepository, ProxyHealthRepository } from "../src/application/proxies/proxy.repository.js";
import { ProxyService } from "../src/application/proxies/proxy.service.js";
import { BrowserRunRepository } from "../src/application/lifecycle/browser-run.repository.js";
import { BrowserLifecycleService } from "../src/application/lifecycle/browser.lifecycle.service.js";
import { LaunchIdentityService } from "../src/application/lifecycle/launch-identity.service.js";
import { EngineHealthService } from "../src/application/engine/engine-health.service.js";
import { FakeBrowserRuntime } from "../src/application/runtime/fake.browser-runtime.js";
import {
  ProfileProviderRepository,
  ProxyProviderRepository,
} from "../src/application/providers/provider.repository.js";
import {
  ProfileProviderService,
  ProxyProviderService,
} from "../src/application/providers/provider.service.js";
import { GoogleAuthService } from "../src/application/google/google-auth.service.js";
import type { SheetReader } from "../src/application/google/sheets-client.js";
import type { SecretStore } from "../src/application/secrets/secret-store.js";
import { DomainError, ErrorCodes } from "@queuepilot/contracts";
import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config/config.js";
import { PluginRegistry } from "../src/application/plugins/plugin-registry.js";
import { ResolverRegistry, registerBuiltinResolvers } from "../src/application/resolvers/resolver-registry.js";
import { ParserRegistry } from "../src/application/parsers/parser-registry.js";
import { registerBuiltinParsers } from "../src/application/parsers/builtin-parsers.js";
import { secretAliasStore } from "../src/application/resolvers/token-aliases.js";
import { JylRegistry } from "../src/application/jyl/jyl-registry.js";
import { SettingsService } from "../src/application/settings/settings.service.js";
import { EmailAccountService } from "../src/application/email/email-account.service.js";
import { TabStateService } from "../src/application/tabs/tab-state.service.js";

/** In-memory SheetReader: tests seed rows per sheetId, no network involved. */
export class FakeSheets implements SheetReader {
  readonly sheets = new Map<string, string[][]>();

  async getValues(sheetId: string, _range: string): Promise<string[][]> {
    const rows = this.sheets.get(sheetId);
    if (!rows) {
      throw new DomainError(
        ErrorCodes.PROVIDER_SOURCE_UNREADABLE,
        `sheet ${sheetId} not found`,
      );
    }
    return rows;
  }
}

/**
 * Shared fixture drop for provider CSVs in tests — mirrors production's
 * `<dataDir>/imports` containment (audit A-rec #2). Tests wire this as an
 * allowed source root alongside the per-context dataDir.
 */
export const TEST_IMPORTS_DIR = path.join(os.tmpdir(), "queuepilot-test-imports");

export interface TestContext {
  app: FastifyInstance;
  lifecycle: BrowserLifecycleService;
  runtime: FakeBrowserRuntime;
  profiles: ProfileService;
  proxies: ProxyService;
  snapshots: LaunchIdentityService;
  profileProviders: ProfileProviderService;
  proxyProviders: ProxyProviderService;
  google: GoogleAuthService;
  sheets: FakeSheets;
  secrets: MapSecretStore;
  aliases: ReturnType<typeof secretAliasStore>;
  plugins: PluginRegistry;
  resolvers: ResolverRegistry;
  jyl: JylRegistry;
  settings: SettingsService;
  emailAccounts: EmailAccountService;
  tabState: TabStateService;
  db: Db;
  dataDir: string;
}

export function makeTestContext(
  runtime: FakeBrowserRuntime = new FakeBrowserRuntime(),
  configPatch: Partial<AppConfig> = {},
): TestContext {
  const db = openTestDatabase();
  const profileRepo = new ProfileRepository(db);
  const identityRepo = new FingerprintIdentityRepository(db);
  const proxyRepo = new ProxyRepository(db);
  const runRepo = new BrowserRunRepository(db);

  const proxies = new ProxyService(proxyRepo, null, new ProxyHealthRepository(db));
  const secrets = new MapSecretStore();
  const profiles = new ProfileService(profileRepo, identityRepo, proxyRepo, secrets);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "queuepilot-test-"));
  const snapshots = new LaunchIdentityService(dataDir);
  const sheets = new FakeSheets();
  const google = new GoogleAuthService({
    secrets,
    dataDir,
    clientId: "test-client-id",
    clientSecret: "test-client-secret",
    redirectUri: "http://127.0.0.1:0/google/auth/callback",
  });
  const profileProviders = new ProfileProviderService(
    new ProfileProviderRepository(db),
    profileRepo,
    identityRepo,
    sheets,
    secrets,
    [dataDir, TEST_IMPORTS_DIR],
  );
  // Built before the lifecycle: D-003 rotation links resolve launch proxies
  // from provider pools at start() time.
  const proxyProviders = new ProxyProviderService(
    new ProxyProviderRepository(db),
    proxyRepo,
    sheets,
    undefined,
    [dataDir, TEST_IMPORTS_DIR],
  );
  const lifecycle = new BrowserLifecycleService(
    profileRepo,
    identityRepo,
    proxies,
    runRepo,
    runtime,
    dataDir,
    snapshots,
    undefined,
    undefined,
    proxyProviders,
  );
  const aliases = secretAliasStore(secrets);
  const resolvers = new ResolverRegistry();
  registerBuiltinResolvers(resolvers); // same set main.ts wires in production
  const parsers = new ParserRegistry(path.join(dataDir, "parsers"));
  registerBuiltinParsers(parsers); // same builtins main.ts wires
  const plugins = new PluginRegistry(path.join(dataDir, "plugins"), resolvers, parsers);
  const jyl = new JylRegistry(path.join(dataDir, "jyl"));
  const settings = new SettingsService(db);
  const emailAccounts = new EmailAccountService(db, secrets);
  const tabState = new TabStateService({ db, profiles, liveTabs: (id) => lifecycle.listTabs(id).tabs });
  const config: AppConfig = {
    port: 0,
    host: "127.0.0.1",
    dataDir,
    runtime: "fake",
    dbPath: ":memory:",
    ...configPatch,
  };
  const app = buildApp({
    config,
    profiles,
    proxies,
    lifecycle,
    profileProviders,
    proxyProviders,
    engineHealth: new EngineHealthService(runtime, dataDir),
    google,
    plugins,
    resolvers,
    parsers,
    aliases,
    // Stand-in for AYCD's /user/verify — tests never call AYCD.
    aycdVerify: async (key: string) =>
      key === "good-aycd-key-1234"
        ? { ok: true, error: null }
        : { ok: false, error: "AYCD Inbox rejected the API key (is the Inbox app running?)" },
    jyl,
    settingsStore: settings,
    secrets,
    emailAccounts,
    tabState,
  });
  return {
    app,
    lifecycle,
    runtime,
    profiles,
    proxies,
    snapshots,
    profileProviders,
    proxyProviders,
    google,
    sheets,
    secrets,
    aliases,
    plugins,
    resolvers,
    jyl,
    settings,
    emailAccounts,
    tabState,
    db,
    dataDir,
  };
}

/** Test SecretStore — plain in-memory, tests only, never production. */
export class MapSecretStore implements SecretStore {
  readonly kind = "map";
  private readonly m = new Map<string, string>();
  set(key: string, value: string): void {
    this.m.set(key, value);
  }
  get(key: string): string | null {
    return this.m.get(key) ?? null;
  }
  delete(key: string): void {
    this.m.delete(key);
  }
}
