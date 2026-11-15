import { ErrorCodes, DomainError } from "@queuepilot/contracts";
import type { PersonaWindowBounds } from "@queuepilot/contracts";
import type { BrowserLifecycleService } from "../lifecycle/browser.lifecycle.service.js";
import type { ProfileService } from "../profiles/profile.service.js";
import { personaFieldsOf } from "../profiles/persona-fields.js";
import { CdpConnection } from "../runtime/cdp/cdp-connection.js";
import {
  cdpWindowDriver,
  type ScreenArea,
  type WindowDriver,
} from "../runtime/window-fit.js";

/**
 * Window tiling (A3) — daily-driver UX over the stealth layer. The
 * window-fit watcher (window-fit.ts) enforces the hard invariant "no window
 * may exceed the profile's claimed screen"; this service decides WHERE
 * windows sit so ten launched profiles don't stack on top of each other.
 *
 * Two presets:
 *   cascade — equal windows stair-stepping down the work area (Jancy style);
 *   grid    — the work area split into as few columns as look square.
 * Every applied rect is remembered per profile (persona `windowBounds`), so
 * a later "restore" pass can put a window back where the operator left it.
 */

export type TilePreset = "cascade" | "grid";

export const TILE_PRESETS: readonly TilePreset[] = ["cascade", "grid"];

export interface TileResult {
  id: string;
  status: "tiled" | "failed";
  applied?: PersonaWindowBounds;
  error?: { code: string; message: string };
}

/** Cascade: equal windows stair-stepping by (stepX, stepY), clamped to area. */
export function cascadeRects(
  n: number,
  area: ScreenArea,
  opts: { width?: number; height?: number; stepX?: number; stepY?: number } = {},
): ScreenArea[] {
  const width = Math.min(opts.width ?? Math.round(area.width * 0.6), area.width);
  const height = Math.min(opts.height ?? Math.round(area.height * 0.7), area.height);
  const stepX = opts.stepX ?? 32;
  const stepY = opts.stepY ?? 24;
  const maxOffsetX = Math.max(area.width - width, 0);
  const maxOffsetY = Math.max(area.height - height, 0);
  const out: ScreenArea[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      left: area.left + Math.min(i * stepX, maxOffsetX),
      top: area.top + Math.min(i * stepY, maxOffsetY),
      width,
      height,
    });
  }
  return out;
}

/** Grid: split the area into as few columns as keep cells roughly square. */
export function gridRects(n: number, area: ScreenArea, opts: { margin?: number } = {}): ScreenArea[] {
  const margin = opts.margin ?? 8;
  if (n <= 0) return [];
  const cols = Math.ceil(Math.sqrt((n * area.width) / area.height));
  const rows = Math.ceil(n / cols);
  const cellW = Math.floor((area.width - margin * (cols + 1)) / cols);
  const cellH = Math.floor((area.height - margin * (rows + 1)) / rows);
  const out: ScreenArea[] = [];
  for (let i = 0; i < n; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    out.push({
      left: area.left + margin + col * (cellW + margin),
      top: area.top + margin + row * (cellH + margin),
      width: Math.max(cellW, 200),
      height: Math.max(cellH, 200),
    });
  }
  return out;
}

export function tileRects(preset: TilePreset, n: number, area: ScreenArea): ScreenArea[] {
  return preset === "grid" ? gridRects(n, area) : cascadeRects(n, area);
}

export class WindowTilingService {
  constructor(
    private readonly lifecycle: BrowserLifecycleService,
    private readonly profiles: ProfileService,
  ) {}

  private async driverFor(profileId: string): Promise<WindowDriver> {
    const run = this.lifecycle.activeRun(profileId);
    if (!run || run.status !== "running" || !run.wsEndpoint) {
      throw new DomainError(
        ErrorCodes.PROFILE_NOT_RUNNING,
        `profile ${profileId} is not running`,
      );
    }
    const conn = await CdpConnection.connect(run.wsEndpoint, 10_000);
    return cdpWindowDriver(conn);
  }

  /** Apply bounds to the profile's window and remember them on the persona. */
  async setBounds(profileId: string, bounds: PersonaWindowBounds): Promise<TileResult> {
    try {
      const driver = await this.driverFor(profileId);
      const windows = await driver.listWindows();
      const win = windows[0];
      if (!win) {
        throw new DomainError(ErrorCodes.PROFILE_NOT_RUNNING, "no window found for profile");
      }
      await driver.setBounds(win.windowId, bounds);
      this.profiles.updatePersona(profileId, { windowBounds: bounds });
      return { id: profileId, status: "tiled", applied: bounds };
    } catch (err) {
      return { id: profileId, status: "failed", error: toErrorBody(err) };
    }
  }

  /**
   * Tile many profiles with one preset. Not-running profiles fail their row
   * and never abort the batch (same philosophy as batch-start).
   */
  async tile(ids: string[], preset: TilePreset, area: ScreenArea): Promise<{ results: TileResult[] }> {
    const rects = tileRects(preset, ids.length, area);
    const results: TileResult[] = [];
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]!;
      const rect = rects[i]!;
      results.push(await this.setBounds(id, rect));
    }
    return { results };
  }

  /** Restore each running profile to its remembered persona geometry. */
  async restore(ids: string[]): Promise<{ results: TileResult[] }> {
    const results: TileResult[] = [];
    for (const id of ids) {
      const remembered = personaFieldsOf(this.profiles.get(id).extra).windowBounds;
      if (!remembered) {
        results.push({
          id,
          status: "failed",
          error: { code: ErrorCodes.VALIDATION_FAILED, message: "no remembered window bounds" },
        });
        continue;
      }
      results.push(await this.setBounds(id, remembered));
    }
    return { results };
  }
}

function toErrorBody(err: unknown): { code: string; message: string } {
  return {
    code: err instanceof Error && "code" in err ? String((err as { code: unknown }).code) : "INTERNAL",
    message: err instanceof Error ? err.message : String(err),
  };
}
