import { z } from "zod";

/**
 * Operator settings (v0.14.13) — the console Settings section's contract.
 * One JSON document per section, stored in the `settings` table, validated
 * here so the UI and the API agree on shape. PATCH merges shallowly:
 * absent keys keep their stored value.
 */

export const SETTINGS_SECTIONS = [
  "general",
  "engine",
  "launch",
  "team",
  "integrations",
  "automation",
] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export const GeneralSettingsSchema = z.object({
  /** Console look. "jancy" = the dark dense default (the shipped theme). */
  theme: z.enum(["jancy", "light"]).default("jancy"),
  density: z.enum(["comfortable", "pro"]).default("comfortable"),
  language: z.enum(["en", "es"]).default("en"),
  startOnBoot: z.boolean().default(false),
});
export type GeneralSettings = z.infer<typeof GeneralSettingsSchema>;

export const EngineSettingsSchema = z.object({
  /** Engine update channel offered by the installer/updater. */
  channel: z.enum(["stable", "beta"]).default("stable"),
  /** Explicit operator consent before any engine binary download. */
  downloadConsent: z.boolean().default(false),
  /**
   * Where the client looks for engine updates: the owner's server URL of an
   * engines manifest (hosted-deployment track). Empty = SPECTRA_ENGINE_MANIFEST,
   * else the repo's raw manifest. http(s) only.
   */
  updateUrl: z
    .string()
    .max(500)
    .refine((v) => v === "" || /^https?:\/\/[^\s]+$/i.test(v), "must be an http(s) URL or empty")
    .default(""),
});
export type EngineSettings = z.infer<typeof EngineSettingsSchema>;

export const LaunchSettingsSchema = z.object({
  /** Default delay between profile starts in a batch (ms, 0 = no delay). */
  batchStaggerMs: z.number().int().min(0).max(60_000).default(0),
  /** Optional host-wide cap; 0 = no cap beyond the built-in guard. */
  maxConcurrent: z.number().int().min(0).max(500).default(0),
  /** Open the profile's configured start pages at launch. */
  openStartPages: z.boolean().default(true),
});
export type LaunchSettings = z.infer<typeof LaunchSettingsSchema>;

export const TeamSettingsSchema = z.object({
  serverUrl: z.string().url().nullable().default(null),
  token: z.string().max(500).nullable().default(null),
  /** Groups whose profiles are offered for one-click bundle sync. */
  syncGroups: z.array(z.string().max(120)).max(50).default([]),
  /**
   * Passphrase for the background sync loop (P7.7c) — seals bundles it pulls.
   * Stored here, plaintext, same honesty as `token`: team mode already
   * treats this machine as inside the trust boundary.
   */
  syncPassphrase: z.string().max(200).nullable().default(null),
});
export type TeamSettings = z.infer<typeof TeamSettingsSchema>;

export const IntegrationsSettingsSchema = z.object({
  /** Display name of the connected Google account, if any. */
  googleAccount: z.string().max(200).nullable().default(null),
  /** Note slot for where provider credentials live (never stores secrets). */
  providersNote: z.string().max(2000).default(""),
});
export type IntegrationsSettings = z.infer<typeof IntegrationsSettingsSchema>;

export const AutomationSettingsSchema = z.object({
  /** Data-dir relative paths or names of enabled plugins (API is source of truth). */
  enabledPlugins: z.array(z.string().max(200)).max(100).default([]),
  /** Names of enabled JYL commands/macros. */
  enabledJyl: z.array(z.string().max(200)).max(200).default([]),
  /**
   * v0.15.0 (audit A-rec #3): explicit operator opt-in for the code-running
   * HTTP endpoints — JYL run/endpoints, plugin/parser/resolver execution,
   * alias writes. Default OFF: these run code and touch secrets, so a
   * loopback caller must not reach them by default.
   */
  scriptingEndpoints: z.boolean().default(false),
});
export type AutomationSettings = z.infer<typeof AutomationSettingsSchema>;

export const SettingsSchema = z.object({
  general: GeneralSettingsSchema.default({}),
  engine: EngineSettingsSchema.default({}),
  launch: LaunchSettingsSchema.default({}),
  team: TeamSettingsSchema.default({}),
  integrations: IntegrationsSettingsSchema.default({}),
  automation: AutomationSettingsSchema.default({}),
});
export type Settings = z.infer<typeof SettingsSchema>;

/** Per-section partial-update schemas (PATCH bodies). */
export const SettingsPatchSchemas = {
  general: GeneralSettingsSchema.partial(),
  engine: EngineSettingsSchema.partial(),
  launch: LaunchSettingsSchema.partial(),
  team: TeamSettingsSchema.partial(),
  integrations: IntegrationsSettingsSchema.partial(),
  automation: AutomationSettingsSchema.partial(),
} as const;
