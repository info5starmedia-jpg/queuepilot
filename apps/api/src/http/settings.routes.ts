import type { FastifyInstance } from "fastify";
import {
  SettingsBundleSchema,
  type SettingsBundleService,
} from "../application/settings/settings-bundle.service.js";

export interface SettingsDeps {
  settings: SettingsBundleService;
}

/**
 * Settings bundles — /settings/export produces a secrets-free JSON snapshot
 * (alias names, plugin toggles, provider configs); /settings/import upserts
 * it on another machine. Alias VALUES never travel (they live in the
 * SecretStore); the import result says so explicitly.
 */
export function registerSettingsRoutes(app: FastifyInstance, deps: SettingsDeps): void {
  app.get("/settings/export", async () => deps.settings.export());

  app.post("/settings/import", async (req) => {
    const bundle = SettingsBundleSchema.parse(req.body);
    return deps.settings.import(bundle);
  });
}
