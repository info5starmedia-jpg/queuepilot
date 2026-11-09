import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { openTestDatabase } from "../src/infrastructure/database.js";
import { ProfileRepository, FingerprintIdentityRepository } from "../src/application/profiles/profile.repository.js";
import { ProfileService } from "../src/application/profiles/profile.service.js";
import { ProxyRepository } from "../src/application/proxies/proxy.repository.js";
import { ProxyService } from "../src/application/proxies/proxy.service.js";
import { BrowserRunRepository } from "../src/application/lifecycle/browser-run.repository.js";
import { BrowserLifecycleService } from "../src/application/lifecycle/browser.lifecycle.service.js";
import { LaunchIdentityService } from "../src/application/lifecycle/launch-identity.service.js";
import { FakeBrowserRuntime } from "../src/application/runtime/fake.browser-runtime.js";
import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config/config.js";

export interface TestContext {
  app: FastifyInstance;
  lifecycle: BrowserLifecycleService;
  runtime: FakeBrowserRuntime;
  profiles: ProfileService;
  proxies: ProxyService;
  snapshots: LaunchIdentityService;
  dataDir: string;
}

export function makeTestContext(): TestContext {
  const db = openTestDatabase();
  const profileRepo = new ProfileRepository(db);
  const identityRepo = new FingerprintIdentityRepository(db);
  const proxyRepo = new ProxyRepository(db);
  const runRepo = new BrowserRunRepository(db);

  const proxies = new ProxyService(proxyRepo);
  const profiles = new ProfileService(profileRepo, identityRepo, proxyRepo);
  const runtime = new FakeBrowserRuntime();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "queuepilot-test-"));
  const snapshots = new LaunchIdentityService(dataDir);
  const lifecycle = new BrowserLifecycleService(
    profileRepo,
    identityRepo,
    proxies,
    runRepo,
    runtime,
    dataDir,
    snapshots,
  );
  const config: AppConfig = {
    port: 0,
    host: "127.0.0.1",
    dataDir,
    runtime: "fake",
    dbPath: ":memory:",
  };
  const app = buildApp({ config, profiles, proxies, lifecycle });
  return { app, lifecycle, runtime, profiles, proxies, snapshots, dataDir };
}
