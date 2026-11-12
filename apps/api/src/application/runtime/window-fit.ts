import type { FingerprintIdentity } from "@queuepilot/contracts";
import { CdpConnection } from "./cdp/cdp-connection.js";

/**
 * Window fit — keeps every engine window no larger than the screen its
 * profile claims (AliasMode's window-fit.ts, ported).
 *
 * PORTED FROM: github.com/aliasmode/aliasmode `window-fit.ts`
 * LICENSE: Apache-2.0 — reusable with attribution. The original
 * window-fit.ts header explains the threat:
 *
 *   A page reads screen.* from the profile, but outerWidth, innerHeight and
 *   screenX from the real window. A window maximized on a display bigger
 *   than that screen is bigger than the screen the page sees, and a page
 *   finds that in one comparison (innerHeight > screen.height).
 *
 * Attribution: Copyright (c) AliasMode contributors, Apache-2.0.
 *
 * What we kept verbatim (pure geometry — the hard part is the DPI rounding
 * and the hidden maximized border, both measured against real Chromium):
 *   maximizedBorder, sizeAtScale, fitWindow.
 * What we changed:
 *   - claimedScreenArea derives from our FingerprintIdentity (no stored
 *     capture yet — the whole claimed screen is the area, same last-resort
 *     shape as upstream).
 *   - The watcher uses our CdpConnection and only the browser-level Browser
 *     domain (getWindowForTarget / getWindowBounds / setWindowBounds). It
 *     never attaches to a page — the same boundary upstream keeps.
 *   - Upstream restores a maximized window's previous bounds after an
 *     over-large maximize; we un-maximize to fitted normal bounds (P1
 *     honesty: a fix the window manager refuses is not retried, so there is
 *     no resize loop). Restoring pre-maximize geometry is P2 polish.
 */

export interface ScreenArea {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface WindowBounds extends Partial<ScreenArea> {
  windowState?: string;
}

/** The profile's claimed screen as its pages read it. */
export function claimedScreenArea(identity: FingerprintIdentity | null): ScreenArea {
  return {
    left: 0,
    top: 0,
    width: identity?.screenWidth ?? 1920,
    height: identity?.screenHeight ?? 1080,
  };
}

/**
 * On Windows, CDP reports a maximized window with its hidden resize border,
 * which hangs off the monitor: (-8,-8,1936,1048) for a page that reads
 * (0,0,1920,1032). The border is the same on every side and at most 16 px at
 * 150%. Other systems have none.
 */
function maximizedBorder({ left = 0, top = 0 }: WindowBounds): number {
  const insets = [-left, -top].filter((inset) => inset > 0 && inset <= 16);
  return insets.length ? Math.min(...insets) : 0;
}

/**
 * The largest window size Chromium draws at `scale` that a page reads as no
 * more than `size`. It rounds a window out to whole device pixels and back:
 * 566 at 125% is 708 px, read as 567.
 */
function sizeAtScale(size: number, scale: number): number {
  let fitted = size;
  while (fitted > 1 && Math.ceil(Math.ceil(fitted * scale - 1e-6) / scale - 1e-6) > size) fitted--;
  return fitted;
}

/**
 * The bounds that make a window fit `area`'s size, or null when it already
 * does or must be left alone. At a fractional scale CDP rounds a maximized
 * window's bounds outward: one that a page reads as 1536x826 at 125% comes
 * back as (-6,-6,1550,839), 2 px too large.
 */
export function fitWindow(
  bounds: WindowBounds,
  area: ScreenArea,
  scale = 1,
): ScreenArea | null {
  const { windowState } = bounds;
  if (windowState === "minimized" || windowState === "fullscreen") return null;
  if (bounds.left === undefined || bounds.top === undefined || bounds.width === undefined || bounds.height === undefined) return null;
  const maximized = windowState === "maximized";
  const border = maximized ? maximizedBorder(bounds) : 0;
  const left = bounds.left + border;
  const top = bounds.top + border;
  const width = bounds.width - 2 * border;
  const height = bounds.height - 2 * border;
  const slack = maximized && !Number.isInteger(scale) ? 2 : 0;
  if (width <= area.width + slack && height <= area.height + slack) return null;
  return {
    left,
    top,
    width: Math.min(width, sizeAtScale(area.width, scale)),
    height: Math.min(height, sizeAtScale(area.height, scale)),
  };
}

/**
 * The WindowDriver boundary exists so the watcher is unit-testable without a
 * browser: production wires it to CdpConnection's browser-level socket.
 */
export interface WindowDriver {
  /** Every open window and its current bounds. */
  listWindows(): Promise<{ windowId: number; bounds: WindowBounds }[]>;
  setBounds(windowId: number, bounds: ScreenArea): Promise<void>;
}

/** Browser-domain driver over a browser-level CDP socket. */
export function cdpWindowDriver(conn: CdpConnection): WindowDriver {
  interface WindowForTargetResult {
    windowId: number;
    bounds: WindowBounds;
  }
  return {
    async listWindows() {
      const { targetInfos } = await conn.call<{ targetInfos: { targetId: string; type: string }[] }>(
        "Target.getTargets",
      );
      const out: { windowId: number; bounds: WindowBounds }[] = [];
      const seen = new Set<number>();
      for (const t of targetInfos) {
        if (t.type !== "page") continue;
        try {
          const w = await conn.call<WindowForTargetResult>("Browser.getWindowForTarget", {
            targetId: t.targetId,
          });
          if (!seen.has(w.windowId)) {
            seen.add(w.windowId);
            out.push({ windowId: w.windowId, bounds: w.bounds });
          }
        } catch {
          // target vanished between listing and lookup — skip
        }
      }
      return out;
    },
    async setBounds(windowId, bounds) {
      await conn.call("Browser.setWindowBounds", {
        windowId,
        bounds: { ...bounds, windowState: "normal" },
      });
    },
  };
}

export interface WindowFitWatcherOptions {
  intervalMs?: number;
  /** The scale the browser draws at (--force-device-scale-factor). */
  scale?: number;
  log?: (msg: string) => void;
}

interface WindowTrack {
  /** Bounds signature as last seen. */
  seen: string;
  /** The last read was answered with a fix; a window still too large after it is left alone. */
  fixed: boolean;
}

/**
 * Watch every window until stop() is called. A fix the window manager
 * refuses is not repeated until the window's bounds change again, so there
 * is no resize loop. Fullscreen and minimized windows are left alone.
 */
export class WindowFitWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly tracks = new Map<number, WindowTrack>();
  private stopped = false;

  constructor(
    private readonly driver: WindowDriver,
    private readonly area: ScreenArea,
    private readonly opts: WindowFitWatcherOptions = {},
  ) {}

  start(): void {
    if (this.timer) return;
    const interval = this.opts.intervalMs ?? 1_000;
    this.timer = setInterval(() => {
      void this.sweep().catch((err) => {
        this.opts.log?.(`window-fit sweep failed: ${String(err)}`);
      });
    }, interval);
    // First sweep immediately so a launch-sized-too-big window is fixed
    // within one interval rather than two.
    void this.sweep().catch(() => {});
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.tracks.clear();
  }

  private async sweep(): Promise<void> {
    if (this.stopped) return;
    const windows = await this.driver.listWindows();
    for (const { windowId, bounds } of windows) {
      const signature = JSON.stringify(bounds);
      let track = this.tracks.get(windowId);
      if (!track) {
        track = { seen: signature, fixed: false };
        this.tracks.set(windowId, track);
      } else if (track.seen === signature) {
        if (track.fixed) continue; // fix already answered, bounds unchanged since
      } else {
        track.seen = signature;
        track.fixed = false; // user moved/resized it — eligible for a fresh fix
      }
      const fix = fitWindow(bounds, this.area, this.opts.scale ?? 1);
      if (!fix) continue;
      try {
        await this.driver.setBounds(windowId, fix);
        // `seen` stays the RAW signature: if the window manager refused the
        // resize, the next read returns the same bounds and `fixed` skips it
        // (no resize loop). A real bounds change resets `fixed`.
        track.fixed = true;
        this.opts.log?.(
          `window-fit: window ${windowId} shrunk ${bounds.width}x${bounds.height}@${bounds.left},${bounds.top} -> ${fix.width}x${fix.height}@${fix.left},${fix.top}`,
        );
      } catch (err) {
        // Refused (e.g. window animating). `fixed` stays false so the next
        // unchanged-bounds read retries, but the sweep interval is the
        // backoff — no tight loop.
        this.opts.log?.(`window-fit: setBounds refused for ${windowId}: ${String(err)}`);
      }
    }
  }
}

/**
 * Launch-time initial window size: the claimed screen minus a standard
 * Windows decoration estimate (8 px resize borders each side + 32 px
 * titlebar). A window exactly equal to the claimed screen reads as a
 * headless tell (innerHeight == screen.height); a real windowed browser is
 * smaller than its screen. The watcher enforces the hard invariant
 * (window <= claimed screen) from the first sweep, so this estimate only
 * sets the opening shape, never the security boundary.
 */
export function initialWindowSize(identity: FingerprintIdentity | null): {
  width: number;
  height: number;
} {
  const area = claimedScreenArea(identity);
  return {
    width: Math.max(320, area.width - 16),
    height: Math.max(240, area.height - 40),
  };
}
