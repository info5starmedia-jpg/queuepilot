import {
  ErrorCodes,
  SETTINGS_SECTIONS,
  SettingsPatchSchemas,
  SettingsSchema,
  type Settings,
  type SettingsSection,
} from "@queuepilot/contracts";
import { DomainError } from "@queuepilot/contracts";
import type { Db } from "../../infrastructure/database.js";

/**
 * Operator settings store (v0.14.13) — one JSON document per section in the
 * `settings` table (migration 006). The contracts package owns the shapes and
 * the defaults; this service only merges, validates and persists.
 *
 * Sync like every other repository here (ADR-0002): reads and the
 * read-merge-validate-write cycle are microsecond-scale, so no async needed.
 */

const FULL_SCHEMAS = SettingsSchema.shape;

function isSection(s: string): s is SettingsSection {
  return (SETTINGS_SECTIONS as readonly string[]).includes(s);
}

function assertSection(s: string): asserts s is SettingsSection {
  if (!isSection(s)) {
    throw new DomainError(
      ErrorCodes.VALIDATION_FAILED,
      `unknown settings section "${s}"; expected one of: ${SETTINGS_SECTIONS.join(", ")}`,
    );
  }
}

interface SettingsRow {
  value: string;
}

export class SettingsService {
  constructor(private readonly db: Db) {}

  private storedDocument(section: SettingsSection): Record<string, unknown> {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE section = ?")
      .get(section) as SettingsRow | undefined;
    if (!row) return {};
    try {
      return JSON.parse(row.value) as Record<string, unknown>;
    } catch {
      // A corrupted row must not brick the console; fall back to defaults.
      return {};
    }
  }

  private merged<S extends SettingsSection>(section: S): Settings[S] {
    return FULL_SCHEMAS[section].parse(this.storedDocument(section)) as Settings[S];
  }

  getAll(): Settings {
    return {
      general: this.merged("general"),
      engine: this.merged("engine"),
      launch: this.merged("launch"),
      team: this.merged("team"),
      integrations: this.merged("integrations"),
      automation: this.merged("automation"),
      sites: this.merged("sites"),
      ui: this.merged("ui"),
    };
  }

  get<S extends SettingsSection>(section: S): Settings[S];
  get(section: string): Settings[SettingsSection];
  get(section: string): Settings[SettingsSection] {
    assertSection(section);
    return this.merged(section);
  }

  /** Soft reset: forget the stored values of these sections (all when omitted) so defaults apply. */
  reset(sections?: string[]): Settings {
    const list = sections ?? [...SETTINGS_SECTIONS];
    for (const s of list) {
      assertSection(s);
      this.db.prepare("DELETE FROM settings WHERE section = ?").run(s);
    }
    return this.getAll();
  }

  patch<S extends SettingsSection>(section: S, partial: unknown): Settings[S];
  patch(section: string, partial: unknown): Settings[SettingsSection];
  patch(section: string, partial: unknown): Settings[SettingsSection] {
    assertSection(section);
    // Validate the patch itself first (zod throws -> 400 VALIDATION_FAILED).
    const patch = SettingsPatchSchemas[section].parse(partial ?? {});
    const merged = { ...this.merged(section), ...patch };
    this.db
      .prepare(
        `INSERT INTO settings (section, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(section) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(section, JSON.stringify(merged), new Date().toISOString());
    return this.merged(section);
  }
}
