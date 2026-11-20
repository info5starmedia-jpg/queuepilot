import fs from "node:fs";
import path from "node:path";
import { DomainError, ErrorCodes } from "@queuepilot/contracts";
import type { ProfileService } from "../profiles/profile.service.js";
import { personaFieldsOf } from "../profiles/persona-fields.js";
import { resolveCardForFill } from "../profiles/card-secrets.js";
import type { SecretStore } from "../secrets/secret-store.js";
import type { TabStateService } from "../tabs/tab-state.service.js";
import {
  BUILTIN_ANY,
  buildMapFillExpression,
  fieldValues,
  parseMap,
  resolveBlocks,
  type FieldSource,
  type FillMode,
  type ParsedMap,
} from "./autofill-map.js";

/**
 * J4 — runs the autofill map against a live page. The map file is read from
 * <dataDir>/autofill.map and re-read whenever its mtime changes (hot reload).
 * Profile values are resolved here; the format functions and the DOM work run
 * in the page. Results name fields only, never values.
 */

export interface MapFillOptions {
  targetId?: string | undefined;
  /** Card set whose cc* fields to resolve (omit = no card fields). */
  card?: string | undefined;
  defaultMode?: FillMode | undefined;
  fillPopulated?: boolean | undefined;
  stripCommas?: boolean | undefined;
  wpm?: number | undefined;
}

export interface MapFillResult {
  profileId: string;
  blocks: string[];
  filled: string[];
  missing: string[];
  clicked: number;
  errors: string[];
}

export interface MapEvaluator {
  evaluate(profileId: string, expression: string, targetId?: string, timeoutMs?: number): Promise<unknown>;
  /** The fill itself runs here: an isolated world, not the page's own. */
  evaluateIsolated(profileId: string, expression: string, targetId?: string, timeoutMs?: number): Promise<unknown>;
}

export class AutofillMapService {
  private cache: { mtime: number; map: ParsedMap } | null = null;

  constructor(
    private readonly deps: {
      profiles: Pick<ProfileService, "get">;
      pages: MapEvaluator;
      tabState: Pick<TabStateService, "get" | "takePasscode">;
      secrets?: SecretStore | undefined;
      dataDir: string;
    },
  ) {}

  private get file(): string {
    return path.join(this.deps.dataDir, "autofill.map");
  }

  /** The parsed map (just the built-in `any` block when the file doesn't exist). */
  map(): ParsedMap {
    let mtime = 0;
    try {
      mtime = fs.statSync(this.file).mtimeMs;
    } catch {
      /* no file yet */
    }
    if (!this.cache || this.cache.mtime !== mtime) {
      this.cache = { mtime, map: parseMap(mtime ? fs.readFileSync(this.file, "utf8") : "") };
    }
    return this.cache.map;
  }

  status(): { exists: boolean; blocks: number; errors: { line: number; message: string }[] } {
    const m = this.map();
    return { exists: fs.existsSync(this.file), blocks: m.blocks.length - 1, errors: m.errors };
  }

  /** Save a new map file; refuses text that has parse errors so a typo never half-loads. */
  save(text: string): ReturnType<AutofillMapService["status"]> {
    const parsed = parseMap(text);
    if (parsed.errors.length) {
      throw new DomainError(
        ErrorCodes.VALIDATION_FAILED,
        `autofill map has errors: ${parsed.errors.slice(0, 5).map((e) => `line ${e.line}: ${e.message}`).join("; ")}`,
      );
    }
    fs.mkdirSync(this.deps.dataDir, { recursive: true });
    fs.writeFileSync(this.file, text, "utf8");
    this.cache = null;
    return this.status();
  }

  async fill(profileId: string, opts: MapFillOptions = {}): Promise<MapFillResult> {
    const profile = this.deps.profiles.get(profileId);
    const url = String(await this.deps.pages.evaluate(profileId, "location.href", opts.targetId, 10_000));
    const map = this.map();
    const block = resolveBlocks(map, url, BUILTIN_ANY);

    const persona = personaFieldsOf(profile.extra);
    const state = this.deps.tabState.get(profileId);
    const codes: NonNullable<FieldSource["codes"]> = {};
    for (const k of ["emailCode", "smsCode", "otherCode"] as const) {
      const r = state.codes[k];
      if (r && !r.isError) codes[k] = { value: r.value, timestamp: r.timestamp };
    }
    const source: FieldSource = {
      name: profile.name,
      email: profile.email,
      address: persona.address ?? null,
      phone: persona.phone ?? null,
      sms: persona.smsNumbers?.[0]?.number ?? null,
      dob: persona.dob ?? null,
      free: freeColumns(profile.extra),
      codes,
    };
    if (opts.card) {
      const c = resolveCardForFill(profileId, profile.extra, opts.card, this.deps.secrets);
      const [mm, yy] = (c.expDate ?? "").split("/");
      source.card = { number: c.number, cvv: c.cvv, expMonth: mm ?? null, expYear: yy ?? null, note: c.note };
    }
    const all = fieldValues(source, map.swaps);
    // Only the fields a matched rule (or a format function mentioning it) needs travel into the page.
    const needed = (k: string) => block.rules.some((r) => r.field === k || (r.format ?? "").includes(k));
    const values = Object.fromEntries(Object.entries(all).filter(([k]) => needed(k)));
    // The passcode is consumed (marked used) only when a rule asks for it.
    if (block.rules.some((r) => r.field === "passcode")) {
      const code = this.deps.tabState.takePasscode(profileId);
      if (code) values.passcode = code;
    }

    const expression = buildMapFillExpression({
      rules: block.rules,
      values,
      href: url,
      human: [...block.human],
      machine: [...block.machine],
      defaultMode: opts.defaultMode ?? "machine",
      fillPopulated: opts.fillPopulated ?? false,
      stripCommas: opts.stripCommas ?? false,
      traverseShadow: block.traverseShadow,
      wpm: opts.wpm ?? 60,
    });
    const raw = (await this.deps.pages.evaluateIsolated(profileId, expression, opts.targetId, 120_000)) as Partial<MapFillResult> | null;
    return {
      profileId,
      blocks: block.blocks,
      filled: raw?.filled ?? [],
      missing: raw?.missing ?? [],
      clicked: raw?.clicked ?? 0,
      errors: raw?.errors ?? [],
    };
  }

  /** Broadcast: the same map fill on many profiles; a failing profile never stops the rest. */
  async broadcast(
    profileIds: string[],
    opts: MapFillOptions = {},
  ): Promise<{ profileId: string; ok: boolean; result?: MapFillResult; error?: string }[]> {
    const out: { profileId: string; ok: boolean; result?: MapFillResult; error?: string }[] = [];
    for (const id of profileIds) {
      try {
        out.push({ profileId: id, ok: true, result: await this.fill(id, { ...opts, targetId: undefined }) });
      } catch (e) {
        out.push({ profileId: id, ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return out;
  }
}

function freeColumns(extra: Record<string, unknown> | null): Record<string, string> {
  const out: Record<string, string> = {};
  const bag = (extra?.free ?? extra ?? {}) as Record<string, unknown>;
  for (let i = 1; i <= 10; i++) {
    const v = bag[`free${i}`] ?? bag[`Free ${i}`];
    if (typeof v === "string" && v) out[`free${i}`] = v;
  }
  return out;
}
