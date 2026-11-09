import { loadConfig } from "./config/config.js";
import { openDatabase } from "./infrastructure/database.js";
import { ProfileRepository, FingerprintIdentityRepository } from "./application/profiles/profile.repository.js";
import { ProfileService } from "./application/profiles/profile.service.js";
import { ProxyRepository } from "./application/proxies/proxy.repository.js";
import { ProxyService } from "./application/proxies/proxy.service.js";
import { BrowserRunRepository } from "./application/lifecycle/browser-run.repository.js";
import { BrowserLifecycleService } from "./application/lifecycle/browser.lifecycle.service.js";
import { LaunchIdentityService } from "./application/lifecycle/launch-identity.service.js";
import { FakeBrowserRuntime } from "./application/runtime/fake.browser-runtime.js";
import { CamoufoxRuntime, defaultCamoufoxPath } from "./application/runtime/camoufox.runtime.js";
import type { BrowserRuntime } from "./application/runtime/browser-runtime.js";
import { buildApp } from "./app.js";

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

  const proxies = new ProxyService(proxyRepo);
  const profiles = new ProfileService(profileRepo, identityRepo, proxyRepo);

  const runtime: BrowserRuntime =
    config.runtime === "fake"
      ? new FakeBrowserRuntime()
      : new CamoufoxRuntime(defaultCamoufoxPath);

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

  const app = buildApp({ config, profiles, proxies, lifecycle });
  await app.listen({ port: config.port, host: config.host });
  console.log(
    `[queuepilot] API listening on http://${config.host}:${config.port} (runtime: ${runtime.kind})`,
  );
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
