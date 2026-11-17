import type { FastifyInstance } from "fastify";
import { DomainError, ErrorCodes } from "@queuepilot/contracts";
import {
  SettingsBundleSchema,
  type SettingsBundleService,
} from "../application/settings/settings-bundle.service.js";
import type { SettingsService } from "../application/settings/settings.service.js";

export interface SettingsDeps {
  settings: SettingsBundleService;
}

export interface SettingsSectionDeps {
  store: SettingsService;
  /**
   * Audit GPT-5.4 finding 1: the dashboard toggle may not turn scripting on
   * while the API runs without SPECTRA_API_TOKEN — an RCE surface with no
   * credential requirement is the flagged hole. Undefined = don't enforce
   * (legacy call sites); buildApp always passes it.
   */
  hasApiToken?: boolean;
}

/**
 * Returns a 403-ready DomainError if `body` would enable scripting on a
 * token-less deployment. Called by the settings PATCH route.
 */
export function scriptingEnableGuard(
  section: string,
  body: unknown,
  hasApiToken: boolean | undefined,
): void {
  if (hasApiToken !== false) return; // undefined or true: nothing to refuse
  if (section !== "automation" || typeof body !== "object" || body === null) return;
  if ((body as Record<string, unknown>).scriptingEndpoints === true) {
    throw new DomainError(
      ErrorCodes.FORBIDDEN,
      "cannot enable scripting endpoints while SPECTRA_API_TOKEN is unset — set the env var and restart the API first",
    );
  }
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

/**
 * Operator settings sections (v0.14.13) — the console Settings page.
 * Mounted under /settings/sections/:section so the param route can never
 * shadow the static /settings/export and /settings/import bundle routes.
 */
export function registerSettingsSectionRoutes(
  app: FastifyInstance,
  deps: SettingsSectionDeps,
): void {
  app.get("/settings/sections", async () => deps.store.getAll());

  app.get("/settings/sections/:section", async (req) => {
    const { section } = req.params as { section: string };
    return deps.store.get(section);
  });

  app.patch("/settings/sections/:section", async (req) => {
    const { section } = req.params as { section: string };
    scriptingEnableGuard(section, req.body, deps.hasApiToken);
    return deps.store.patch(section, req.body);
  });
}
