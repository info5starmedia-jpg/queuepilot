import { z } from "zod";
import type { AliasStore } from "../resolvers/token-aliases.js";
import type { PluginRegistry } from "../plugins/plugin-registry.js";
import type {
  ProfileProviderService,
  ProxyProviderService,
} from "../providers/provider.service.js";

/**
 * Settings bundles — Jancy's "move your setup between machines" idea, minus
 * the secrets. A bundle is JSON with everything that is safe to carry around:
 * alias NAMES (never values — a token alias without its secret is just a
 * name; re-enter those on the new machine), plugin enable toggles, and
 * provider configurations (source paths / sheet ids / distribution modes).
 *
 * Deliberately excluded: anything from the SecretStore (alias values, proxy
 * passwords, TOTP seeds, Google tokens) and the profiles/proxies themselves
 * (those have their own CSV/Sheet/bundle pipelines).
 *
 * Import is upsert-by-name and never destructive: existing providers are
 * left alone, existing aliases are left alone, and every skipped/failed item
 * is reported rather than silently dropped.
 */

export const SETTINGS_BUNDLE_VERSION = 1;

const ProviderSchema = z.object({
  name: z.string().min(1).max(200),
  type: z.enum(["csv", "file", "googleSheet"]),
  sourcePath: z.string().nullable().default(null),
  sheetId: z.string().nullable().default(null),
  sheetRange: z.string().nullable().default(null),
});

export const SettingsBundleSchema = z.object({
  version: z.literal(SETTINGS_BUNDLE_VERSION),
  exportedAt: z.string(),
  aliases: z.array(z.string()).default([]),
  plugins: z.array(z.object({ id: z.string(), enabled: z.boolean() })).default([]),
  profileProviders: z
    .array(ProviderSchema.extend({}))
    .default([]),
  proxyProviders: z
    .array(
      ProviderSchema.extend({
        delimiter: z.enum([",", "\t", ":", ";"]).default(","),
        hasHeader: z.boolean().default(false),
        distribution: z.enum(["persist", "start-over", "random"]).default("start-over"),
      }),
    )
    .default([]),
});

export type SettingsBundle = z.infer<typeof SettingsBundleSchema>;

export interface SettingsExportResult {
  version: number;
  exportedAt: string;
  aliases: string[];
  plugins: { id: string; enabled: boolean }[];
  profileProviders: unknown[];
  proxyProviders: unknown[];
}

export interface SettingsImportResult {
  plugins: { applied: number; skipped: number };
  aliases: { exported: number; imported: number; note: string };
  profileProviders: { created: number; existing: number; failed: { name: string; error: string }[] };
  proxyProviders: { created: number; existing: number; failed: { name: string; error: string }[] };
}

export class SettingsBundleService {
  constructor(
    private readonly aliases: AliasStore,
    private readonly plugins: PluginRegistry,
    private readonly profileProviders: ProfileProviderService,
    private readonly proxyProviders: ProxyProviderService,
  ) {}

  export(): SettingsExportResult {
    return {
      version: SETTINGS_BUNDLE_VERSION,
      exportedAt: new Date().toISOString(),
      // Alias VALUES live in the SecretStore and never leave the machine.
      aliases: this.aliases.list().map((a) => a.alias),
      plugins: this.plugins.list().map((p) => ({ id: p.id, enabled: p.enabled })),
      profileProviders: this.profileProviders.list().map((p) => ({
        name: p.name,
        type: p.type,
        sourcePath: p.sourcePath,
        sheetId: p.sheetId,
        sheetRange: p.sheetRange,
      })),
      proxyProviders: this.proxyProviders.list().map((p) => ({
        name: p.name,
        type: p.type,
        sourcePath: p.sourcePath,
        sheetId: p.sheetId,
        sheetRange: p.sheetRange,
        delimiter: p.delimiter,
        hasHeader: p.hasHeader,
        distribution: p.distribution,
      })),
    };
  }

  async import(bundle: SettingsBundle): Promise<SettingsImportResult> {
    const result: SettingsImportResult = {
      plugins: { applied: 0, skipped: 0 },
      aliases: {
        exported: bundle.aliases.length,
        imported: 0,
        note: "alias values are secrets and are never exported; re-enter them with PUT /aliases/:alias",
      },
      profileProviders: { created: 0, existing: 0, failed: [] },
      proxyProviders: { created: 0, existing: 0, failed: [] },
    };

    for (const p of bundle.plugins) {
      const known = this.plugins.list().find((k) => k.id === p.id);
      if (!known) {
        result.plugins.skipped++;
        continue;
      }
      await this.plugins.setEnabled(p.id, p.enabled);
      result.plugins.applied++;
    }

    for (const cfg of bundle.profileProviders) {
      const exists = this.profileProviders.list().some((p) => p.name === cfg.name);
      if (exists) {
        result.profileProviders.existing++;
        continue;
      }
      try {
        await this.profileProviders.create({
          name: cfg.name,
          sourcePath: cfg.sourcePath ?? undefined,
          sheetId: cfg.sheetId ?? undefined,
          sheetRange: cfg.sheetRange ?? undefined,
        });
        result.profileProviders.created++;
      } catch (err) {
        result.profileProviders.failed.push({
          name: cfg.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    for (const cfg of bundle.proxyProviders) {
      const exists = this.proxyProviders.list().some((p) => p.name === cfg.name);
      if (exists) {
        result.proxyProviders.existing++;
        continue;
      }
      try {
        await this.proxyProviders.create({
          name: cfg.name,
          sourcePath: cfg.sourcePath ?? undefined,
          sheetId: cfg.sheetId ?? undefined,
          sheetRange: cfg.sheetRange ?? undefined,
          delimiter: cfg.delimiter,
          hasHeader: cfg.hasHeader,
          distribution: cfg.distribution,
        });
        result.proxyProviders.created++;
      } catch (err) {
        result.proxyProviders.failed.push({
          name: cfg.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return result;
  }
}
