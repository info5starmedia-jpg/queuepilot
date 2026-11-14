import { loadConfig } from "./config/config.js";
import { openDatabase } from "./infrastructure/database.js";
import {
  ProfileRepository,
  FingerprintIdentityRepository,
} from "./application/profiles/profile.repository.js";
import { ProfileService } from "./application/profiles/profile.service.js";
import { ProxyRepository } from "./application/proxies/proxy.repository.js";
import { ProxyService } from "./application/proxies/proxy.service.js";
import { createSecretStore } from "./application/secrets/secret-store.js";
import { BundleService } from "./application/bundles/bundle.service.js";
import {
  exportCookiesViaCdp,
  importCookiesViaCdp,
} from "./application/bundles/cdp-cookies.js";
import { BrowserRunRepository } from "./application/lifecycle/browser-run.repository.js";
import { BrowserLifecycleService } from "./application/lifecycle/browser.lifecycle.service.js";
import { LaunchIdentityService } from "./application/lifecycle/launch-identity.service.js";
import { EngineHealthService } from "./application/engine/engine-health.service.js";
import { runEngineInstall } from "./cli/engine-install.js";
import { runEngineUpdate } from "./cli/engine-update.js";
import { runRemoteCli } from "./cli/remote.js";
import { runScript } from "./cli/script-runner.js";
import { GoogleAuthService } from "./application/google/google-auth.service.js";
import { SheetsClient } from "./application/google/sheets-client.js";
import {
  ProfileProviderRepository,
  ProxyProviderRepository,
} from "./application/providers/provider.repository.js";
import {
  ProfileProviderService,
  ProxyProviderService,
} from "./application/providers/provider.service.js";
import { FakeBrowserRuntime } from "./application/runtime/fake.browser-runtime.js";
import {
  CamoufoxRuntime,
  defaultCamoufoxPath,
} from "./application/runtime/camoufox.runtime.js";
import {
  FuryCoreRuntime,
  resolveFuryBinary,
} from "./application/runtime/fury-core.runtime.js";
import type { BrowserRuntime } from "./application/runtime/browser-runtime.js";
import { buildApp } from "./app.js";
import { ResolverRegistry, registerBuiltinResolvers } from "./application/resolvers/resolver-registry.js";
import { registerImapResolver } from "./application/resolvers/imap-resolver.js";
import { registerGmailResolver } from "./application/resolvers/gmail-resolver.js";
import { JylRegistry } from "./application/jyl/jyl-registry.js";
import { ParserRegistry } from "./application/parsers/parser-registry.js";
import { PluginRegistry } from "./application/plugins/plugin-registry.js";
import { secretAliasStore } from "./application/resolvers/token-aliases.js";
import path from "node:path";

/**
 * CLI entry: `queuepilot engine install ...` runs and exits; anything else
 * starts the API server. Returns null when the server should start.
 */
async function dispatchCli(argv: string[]): Promise<number | null> {
  if (argv[0] === "engine" && argv[1] === "install") {
    const config = loadConfig();
    return runEngineInstall(argv.slice(2), {
      enginesDir: `${config.dataDir}/engines`,
    });
  }
  if (argv[0] === "engine" && argv[1] === "update") {
    const config = loadConfig();
    return runEngineUpdate(argv.slice(2), {
      enginesDir: `${config.dataDir}/engines`,
    });
  }
  if (argv[0] === "script") {
    return runScript(argv.slice(1));
  }
  if (argv[0] === "profiles" || argv[0] === "profile") {
    return runRemoteCli(argv);
  }
  return null;
}

/**
 * Composition root: the only place that knows how the pieces are wired.
 */
export async function main(): Promise<void> {
  const config = loadConfig();
  const db = openDatabase(config.dbPath);

  const profileRepo = new ProfileRepository(db);
  const identityRepo = new FingerprintIdentityRepository(db);
  const proxyRepo = new ProxyRepository(db);
  const runRepo = new BrowserRunRepository(db);

  const secretStore = createSecretStore();
  const proxies = new ProxyService(proxyRepo, secretStore);
  const profiles = new ProfileService(profileRepo, identityRepo, proxyRepo);

  // Plugin + resolver + parser registries (Jancy workflow layer, P7).
  const resolvers = new ResolverRegistry();
  registerBuiltinResolvers(resolvers);
  registerImapResolver(resolvers);
  const parserReg = new ParserRegistry(path.join(config.dataDir, "parsers"));
  await parserReg.rescan();
  const pluginReg = new PluginRegistry(
    path.join(config.dataDir, "plugins"),
    resolvers,
    parserReg,
  );
  await pluginReg.rescan();
  const jyl = new JylRegistry(path.join(config.dataDir, "jyl"));
  await jyl.rescan();

  const google = new GoogleAuthService({
    secrets: secretStore,
    dataDir: config.dataDir,
    clientId: config.googleClientId ?? null,
    clientSecret: config.googleClientSecret ?? null,
    redirectUri: `http://${config.host}:${config.port}/google/auth/callback`,
  });
  registerGmailResolver(resolvers, google);
  const sheets = new SheetsClient(google);

  const profileProviders = new ProfileProviderService(
    new ProfileProviderRepository(db),
    profileRepo,
    identityRepo,
    sheets,
  );
  const proxyProviders = new ProxyProviderService(
    new ProxyProviderRepository(db),
    proxyRepo,
    sheets,
    secretStore,
  );

  const runtime: BrowserRuntime =
    config.runtime === "fake"
      ? new FakeBrowserRuntime()
      : config.runtime === "fury"
        ? new FuryCoreRuntime(resolveFuryBinary(config.dataDir))
        : new CamoufoxRuntime(defaultCamoufoxPath(config.dataDir));

  const engineHealth = new EngineHealthService(runtime, config.dataDir);

  const lifecycle = new BrowserLifecycleService(
    profileRepo,
    identityRepo,
    proxies,
    runRepo,
    runtime,
    config.dataDir,
    new LaunchIdentityService(config.dataDir),
  );

  // Reconcile runs left occupying by a previous (possibly crashed) process
  // BEFORE opening the port, so the API never reports a stale "running".
  const recovered = lifecycle.reconcileOnBoot();
  if (recovered.adopted || recovered.crashed) {
    console.log(
      `[queuepilot] recovery: adopted=${recovered.adopted} crashed=${recovered.crashed}`,
    );
  }

  const bundles = new BundleService(profiles, lifecycle, {
    export: exportCookiesViaCdp,
    import: importCookiesViaCdp,
  }, proxies);

  const app = buildApp({
    config,
    profiles,
    proxies,
    lifecycle,
    profileProviders,
    proxyProviders,
    engineHealth,
    google,
    bundles,
    plugins: pluginReg,
    jyl,
    resolvers,
    parsers: parserReg,
    aliases: secretAliasStore(secretStore),
  });
  await app.listen({ port: config.port, host: config.host });
  console.log(
    `[queuepilot] API listening on http://${config.host}:${config.port} (runtime: ${runtime.kind})`,
  );
}

const isMain =
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  dispatchCli(process.argv.slice(2))
    .then((code) => {
      if (code === null) return main(); // no CLI command matched — start the API
      process.exit(code);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
