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
import { ProxyRepository } from "../src/application/proxies/proxy.repository.js";
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
import { DomainError, ErrorCodes } from "@queuepilot/contracts";
import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config/config.js";

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
  dataDir: string;
}

export function makeTestContext(
  runtime: FakeBrowserRuntime = new FakeBrowserRuntime(),
): TestContext {
  const db = openTestDatabase();
  const profileRepo = new ProfileRepository(db);
  const identityRepo = new FingerprintIdentityRepository(db);
  const proxyRepo = new ProxyRepository(db);
  const runRepo = new BrowserRunRepository(db);

  const proxies = new ProxyService(proxyRepo);
  const profiles = new ProfileService(profileRepo, identityRepo, proxyRepo);
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
  const sheets = new FakeSheets();
  const google = new GoogleAuthService({
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
  );
  const proxyProviders = new ProxyProviderService(
    new ProxyProviderRepository(db),
    proxyRepo,
    sheets,
  );
  const config: AppConfig = {
    port: 0,
    host: "127.0.0.1",
    dataDir,
    runtime: "fake",
    dbPath: ":memory:",
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
    dataDir,
  };
}
