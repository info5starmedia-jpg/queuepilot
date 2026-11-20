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
  "sites",
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
});
export type EngineSettings = z.infer<typeof EngineSettingsSchema>;

export const LaunchSettingsSchema = z.object({
  /** Default delay between profile starts in a batch (ms, 0 = no delay). */
  batchStaggerMs: z.number().int().min(0).max(60_000).default(0),
  /** Optional host-wide cap; 0 = no cap beyond the built-in guard. */
  maxConcurrent: z.number().int().min(0).max(500).default(0),
  /** Open the profile's configured start pages at launch. */
  openStartPages: z.boolean().default(true),
  /** ADR-0008: put each launched profile into the Profile Deck (one window, a tab per profile). Windows only. */
  deckEnabled: z.boolean().default(false),
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
  /**
   * Jancy Settings → Email (docs.jancy.io/docs/settings/email). Gmail "Max
   * emails per request" (≥1, Jancy default 1) and "Only return emails newer
   * than" for the gmail and imap code resolvers; a message outside the
   * window answers `#FILTERED MSG`.
   */
  emailGmailMaxPerRequest: z.number().int().min(1).max(25).default(1),
  emailGmailNewerThan: z.enum(["disabled", "1h", "2h"]).default("disabled"),
  emailImapNewerThan: z.enum(["disabled", "1h", "2h"]).default("disabled"),
  /**
   * AYCD Inbox code resolver (`aycd:`): how far back an already-arrived
   * email still counts, and how long to wait for one to arrive.
   */
  emailAycdLookbackMin: z.number().int().min(0).max(120).default(10),
  emailAycdTimeoutSec: z.number().int().min(5).max(600).default(60),
  /** SMS provider connectors (schema files): ignore texts older than this (0 = off). */
  smsMaxAgeMin: z.number().int().min(0).max(240).default(10),
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

/**
 * J6 — site plug-ins (Queue-it / Ticketmaster / AXS / Etix readers, page
 * actions, queue-position log) and Discord. Page actions click things, so
 * they are OFF by default; the Discord cookie export is opt-in.
 */
export const DISCORD_EVENTS = [
  "queue.passed",
  "queue.position",
  "cart.timer",
  "code.resolved",
  "code.failed",
  "run.started",
  "run.crashed",
] as const;

export const SitesSettingsSchema = z.object({
  /** Read queue position / cart timer / event info from open tabs. */
  extractorsEnabled: z.boolean().default(true),
  extractorIntervalSec: z.number().int().min(2).max(60).default(5),
  /** Ticketmaster page actions (element clicks; off by default). */
  tmDismissOverlay: z.boolean().default(false),
  tmAutoNoInsurance: z.boolean().default(false),
  tmAutoTerms: z.boolean().default(false),
  /** Phrase search on event pages: a match colours the tab. */
  eventPhrases: z
    .array(z.object({ phrase: z.string().min(1).max(100), colour: z.string().regex(/^#[0-9a-fA-F]{6}$/) }))
    .max(50)
    .default([]),
  /** Append every new queue position to <dataDir>/queue-positions/<event>.csv. */
  queuePositionCsv: z.boolean().default(true),
  /** Discord webhook notifications (the URL itself lives in the secret store). */
  discordEnabled: z.boolean().default(false),
  discordEvents: z.array(z.enum(DISCORD_EVENTS)).max(DISCORD_EVENTS.length).default(["queue.passed", "cart.timer", "code.failed", "run.crashed"]),
  /** Minimum minutes between queue-position posts per profile (0 = never post positions). */
  discordPositionEveryMin: z.number().int().min(0).max(1440).default(0),
  /** Opt-in: allow "send cookies + exit IP to Discord" for a profile. */
  discordCookieExport: z.boolean().default(false),
});
export type SitesSettings = z.infer<typeof SitesSettingsSchema>;

export const SettingsSchema = z.object({
  general: GeneralSettingsSchema.default({}),
  engine: EngineSettingsSchema.default({}),
  launch: LaunchSettingsSchema.default({}),
  team: TeamSettingsSchema.default({}),
  integrations: IntegrationsSettingsSchema.default({}),
  automation: AutomationSettingsSchema.default({}),
  sites: SitesSettingsSchema.default({}),
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
  sites: SitesSettingsSchema.partial(),
} as const;
