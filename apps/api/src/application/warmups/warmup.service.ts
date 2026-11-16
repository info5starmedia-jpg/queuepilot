import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { DomainError, ErrorCodes } from "@queuepilot/contracts";
import type { BrowserLifecycleService } from "../lifecycle/browser.lifecycle.service.js";

/**
 * Warmup recorder + player (P3, v0.16.0) — the Jancy cookie-warmer shape.
 *
 * RECORD: watch a live profile's tab set for a bounded window and capture the
 * URL visit sequence with real dwell times. Poll-based (no engine hooks): the
 * tab registry is the source of truth, so recording works on every runtime
 * that honors listTabs — fury-core, camoufox, fake.
 *
 * PLAY: re-run the recipe on any profile — same URLs, dwell times re-sampled
 * ±20% so replays don't look metronome-perfect (that regularity is itself a
 * detector signal). The profile is started if idle and LEFT RUNNING so the
 * warmed cookies persist in its engine profile; pass stopAfter to shut it
 * down when the recipe finishes.
 *
 * Recipes are plain JSON under <dataDir>/warmups/ — operator-owned files,
 * diffable, hand-editable.
 */

export const WarmupStepSchema = z.object({
  url: z.string().url().max(4000),
  /** Dwell observed at record time (playback re-samples ±20%). */
  dwellMs: z.number().int().min(0).max(3_600_000),
});
export type WarmupStep = z.infer<typeof WarmupStepSchema>;

export const WarmupRecipeSchema = z.object({
  version: z.literal(1),
  id: z.string().uuid(),
  name: z.string().min(1).max(120),
  /** Profile the recipe was recorded from (informational only). */
  sourceProfileId: z.string().uuid().nullable(),
  createdAt: z.string(),
  steps: z.array(WarmupStepSchema).max(200),
});
export type WarmupRecipe = z.infer<typeof WarmupRecipeSchema>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class WarmupService {
  constructor(
    private readonly lifecycle: BrowserLifecycleService,
    private readonly dataDir: string,
  ) {}

  private dir(): string {
    return path.join(this.dataDir, "warmups");
  }

  private file(id: string): string {
    return path.join(this.dir(), `${id}.json`);
  }

  list(): WarmupRecipe[] {
    if (!fs.existsSync(this.dir())) return [];
    const out: WarmupRecipe[] = [];
    for (const name of fs.readdirSync(this.dir())) {
      if (!name.endsWith(".json")) continue;
      try {
        out.push(WarmupRecipeSchema.parse(JSON.parse(fs.readFileSync(path.join(this.dir(), name), "utf8"))));
      } catch {
        /* a corrupt recipe file never breaks the list */
      }
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): WarmupRecipe {
    if (!fs.existsSync(this.file(id))) {
      throw new DomainError(ErrorCodes.WARMUP_NOT_FOUND, `warmup recipe ${id} not found`);
    }
    try {
      return WarmupRecipeSchema.parse(JSON.parse(fs.readFileSync(this.file(id), "utf8")));
    } catch (err) {
      throw new DomainError(
        ErrorCodes.INTERNAL,
        `warmup recipe ${id} is unreadable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  delete(id: string): void {
    this.get(id); // 404 when absent
    fs.unlinkSync(this.file(id));
  }

  /** Create a recipe by hand (no recording) — steps validated by the schema. */
  create(name: string, steps: WarmupStep[], sourceProfileId: string | null = null): WarmupRecipe {
    const recipe = WarmupRecipeSchema.parse({
      version: 1,
      id: randomUUID(),
      name,
      sourceProfileId,
      createdAt: new Date().toISOString(),
      steps,
    });
    fs.mkdirSync(this.dir(), { recursive: true });
    fs.writeFileSync(this.file(recipe.id), JSON.stringify(recipe, null, 2));
    return recipe;
  }

  /**
   * Record a live profile for `durationMs`, polling its tab set every
   * `sampleIntervalMs`. A URL that disappears from the tab set closes its
   * step with the observed dwell; contiguous re-visits of the same URL merge
   * into one step. The profile must already be running — recording a dead
   * engine captures nothing and says so loudly.
   */
  async record(
    profileId: string,
    name: string,
    durationMs: number,
    sampleIntervalMs = 2000,
  ): Promise<WarmupRecipe> {
    const run = this.lifecycle.activeRun(profileId);
    if (!run) {
      throw new DomainError(
        ErrorCodes.PROFILE_NOT_RUNNING,
        `profile ${profileId} has no active browser run — start it before recording`,
      );
    }
    const startedAt = Date.now();
    // url -> {firstSeen, lastSeen} for visits still open.
    const open = new Map<string, { firstSeen: number; lastSeen: number }>();
    const steps: WarmupStep[] = [];

    const close = (url: string, at: number) => {
      const v = open.get(url);
      if (!v) return;
      open.delete(url);
      const dwellMs = at - v.firstSeen;
      const prev = steps[steps.length - 1];
      if (prev && prev.url === url) prev.dwellMs += dwellMs; // contiguous revisit
      else steps.push({ url, dwellMs });
    };

    while (Date.now() - startedAt < durationMs) {
      await sleep(sampleIntervalMs);
      const nowTs = Date.now();
      const urls = new Set(
        this.lifecycle
          .listTabs(profileId)
          .tabs.filter((t) => t.status === "open" && typeof t.url === "string")
          .map((t) => t.url as string),
      );
      for (const url of [...open.keys()]) {
        if (!urls.has(url)) close(url, nowTs);
      }
      for (const url of urls) {
        const v = open.get(url);
        if (v) v.lastSeen = nowTs;
        else open.set(url, { firstSeen: nowTs, lastSeen: nowTs });
      }
    }
    const end = Date.now();
    for (const url of [...open.keys()]) close(url, end);

    if (steps.length === 0) {
      throw new DomainError(
        ErrorCodes.CONFLICT,
        "recording captured no tab visits — did the profile browse anywhere?",
      );
    }
    return this.create(name, steps, profileId);
  }

  /**
   * Replay a recipe on a profile. Starts the profile when idle; dwell per
   * step re-sampled ±20%. One bad step reports its error and the rest still
   * run (a dead link in the chain must not void the warmup). stopAfter:true
   * shuts the profile down when the recipe finishes (default false — the
   * warmed engine profile stays up for whatever comes next).
   */
  async run(
    recipeId: string,
    profileId: string,
    opts: { stopAfter?: boolean; jitter?: number } = {},
  ): Promise<{ recipe: WarmupRecipe; startedByRun: boolean; results: { url: string; ok: boolean; dwellMs: number; error?: string }[] }> {
    const recipe = this.get(recipeId);
    const jitter = opts.jitter ?? 0.2;
    const wasRunning = this.lifecycle.activeRun(profileId) !== null;
    if (!wasRunning) await this.lifecycle.start(profileId);

    const results: { url: string; ok: boolean; dwellMs: number; error?: string }[] = [];
    try {
      for (const step of recipe.steps) {
        const dwellMs = Math.round(step.dwellMs * (1 + (Math.random() * 2 - 1) * jitter));
        try {
          const tab = await this.lifecycle.openTab(profileId, { url: step.url });
          await sleep(Math.max(dwellMs, 50));
          await this.lifecycle.closeTab(profileId, tab.id);
          results.push({ url: step.url, ok: true, dwellMs });
        } catch (err) {
          results.push({
            url: step.url,
            ok: false,
            dwellMs: 0,
            error: err instanceof Error ? err.message.slice(0, 300) : String(err),
          });
          // Step failed — still honor the dwell shape before moving on.
          await sleep(Math.max(dwellMs, 50));
        }
      }
    } finally {
      if (opts.stopAfter && !wasRunning) await this.lifecycle.stop(profileId);
    }
    return { recipe, startedByRun: !wasRunning, results };
  }
}
