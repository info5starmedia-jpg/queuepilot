import fs from "node:fs";
import path from "node:path";
import type { BrowserLifecycleService } from "../lifecycle/browser.lifecycle.service.js";

/**
 * J3b — Jancy's multi-tab workflow commands over the per-tab lifecycle ops.
 *
 * Every command works on one profile's tabs, in the order given, and a tab
 * that fails never aborts the rest (per-item result, same as batch-start).
 * Delays are real waits between items; `focusDelayMs` is the pause between
 * bringing a tab to the front and acting on it (Jancy's "focus delay": pages
 * that only react while visible need a moment of being in front).
 */

export interface ItemResult {
  tabId: string;
  ok: boolean;
  error?: string;
}

const sleepReal = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class TabCommandService {
  constructor(
    private readonly lifecycle: Pick<BrowserLifecycleService, "navigateTab" | "reloadTab" | "focusTab" | "listTabs">,
    private readonly sleep: (ms: number) => Promise<void> = sleepReal,
  ) {}

  /** Change the URL of several tabs. focusDelayMs < 0 = don't bring tabs to the front. */
  async changeUrl(profileId: string, items: { tabId: string; url: string }[], opts: { focusDelayMs: number; delayMs: number }): Promise<ItemResult[]> {
    const out: ItemResult[] = [];
    for (const [i, it] of items.entries()) {
      out.push(
        await this.one(it.tabId, async () => {
          const focus = opts.focusDelayMs >= 0;
          if (focus) {
            await this.lifecycle.focusTab(profileId, it.tabId);
            await this.sleep(opts.focusDelayMs);
          }
          await this.lifecycle.navigateTab(profileId, it.tabId, it.url);
        }),
      );
      if (i < items.length - 1 && opts.delayMs > 0) await this.sleep(opts.delayMs);
    }
    return out;
  }

  /** Reload tabs one after another (soft or hard), with a delay between them. */
  async reloadSequence(profileId: string, tabIds: string[], opts: { hard: boolean; delayMs: number; focusDelayMs: number }): Promise<ItemResult[]> {
    const out: ItemResult[] = [];
    for (const [i, tabId] of tabIds.entries()) {
      out.push(
        await this.one(tabId, async () => {
          if (opts.focusDelayMs >= 0) {
            await this.lifecycle.focusTab(profileId, tabId);
            await this.sleep(opts.focusDelayMs);
          }
          await this.lifecycle.reloadTab(profileId, tabId, { hard: opts.hard });
        }),
      );
      if (i < tabIds.length - 1 && opts.delayMs > 0) await this.sleep(opts.delayMs);
    }
    return out;
  }

  /** CSV of the open tabs of the given profiles (formula-safe). */
  exportTabs(profiles: { id: string; name: string; email: string | null }[]): string {
    const rows = ["profile,email,tabId,url,openedAt"];
    for (const p of profiles) {
      let tabs: { id: string; url: string | null; createdAt: string; status: string }[] = [];
      try {
        tabs = this.lifecycle.listTabs(p.id).tabs;
      } catch {
        /* not running */
      }
      for (const t of tabs.filter((x) => x.status === "open")) rows.push([p.name, p.email ?? "", t.id, t.url ?? "", t.createdAt].map(csv).join(","));
    }
    return `${rows.join("\r\n")}\r\n`;
  }

  private async one(tabId: string, fn: () => Promise<void>): Promise<ItemResult> {
    try {
      await fn();
      return { tabId, ok: true };
    } catch (e) {
      return { tabId, ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}

/** Append one profile note to <dataDir>/notes-log.csv (Jancy's "log profile note"; the Sheet sink is not built). */
export function logNote(dataDir: string, row: { profile: string; email: string | null; note: string }, now = new Date()): void {
  const file = path.join(dataDir, "notes-log.csv");
  fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(file)) fs.appendFileSync(file, "time,profile,email,note\r\n");
  fs.appendFileSync(file, `${[now.toISOString(), row.profile, row.email ?? "", row.note].map(csv).join(",")}\r\n`);
}

/** Quote, and defuse spreadsheet formulas (=, +, -, @ at the start). */
function csv(v: string): string {
  const s = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
