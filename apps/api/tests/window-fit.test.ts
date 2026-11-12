import { describe, expect, it } from "vitest";
import {
  claimedScreenArea,
  fitWindow,
  initialWindowSize,
  WindowFitWatcher,
  type ScreenArea,
  type WindowBounds,
  type WindowDriver,
} from "../src/application/runtime/window-fit.js";

const AREA: ScreenArea = { left: 0, top: 0, width: 1920, height: 1080 };

describe("window-fit pure geometry", () => {
  it("claimedScreenArea falls back to 1920x1080 without identity", () => {
    expect(claimedScreenArea(null)).toEqual({ left: 0, top: 0, width: 1920, height: 1080 });
  });

  it("fitWindow returns null when the window already fits", () => {
    expect(
      fitWindow({ left: 10, top: 10, width: 1280, height: 800, windowState: "normal" }, AREA),
    ).toBeNull();
  });

  it("fitWindow returns null for minimized and fullscreen windows", () => {
    expect(
      fitWindow({ left: 0, top: 0, width: 3840, height: 2160, windowState: "minimized" }, AREA),
    ).toBeNull();
    expect(
      fitWindow({ left: 0, top: 0, width: 3840, height: 2160, windowState: "fullscreen" }, AREA),
    ).toBeNull();
  });

  it("fitWindow returns null for incomplete bounds", () => {
    expect(fitWindow({ width: 3840, windowState: "normal" }, AREA)).toBeNull();
  });

  it("fitWindow shrinks a normal window larger than the claimed screen", () => {
    const fix = fitWindow(
      { left: 0, top: 0, width: 2560, height: 1440, windowState: "normal" },
      AREA,
    );
    expect(fix).toEqual({ left: 0, top: 0, width: 1920, height: 1080 });
  });

  it("fitWindow accounts for the hidden maximized border on Windows", () => {
    // CDP shape for a maximized window on a 1936px-wide display: the border
    // hangs off the monitor. The page reads (0,0,1920,1032); a window at
    // (-8,-8,1936,1048) is exactly that and must NOT be "fixed".
    const fit = fitWindow(
      { left: -8, top: -8, width: 1936, height: 1048, windowState: "maximized" },
      { left: 0, top: 0, width: 1920, height: 1032 },
    );
    expect(fit).toBeNull();
  });

  it("fitWindow shrinks a maximize on a display bigger than the claimed screen", () => {
    // Maximized on a 2560px display while the profile claims 1920x1080.
    const fix = fitWindow(
      { left: -8, top: -8, width: 2576, height: 1416, windowState: "maximized" },
      AREA,
    );
    expect(fix).not.toBeNull();
    expect(fix!.width).toBeLessThanOrEqual(AREA.width);
    expect(fix!.height).toBeLessThanOrEqual(AREA.height);
    // Position moves inside the monitor (border stripped), never negative.
    expect(fix!.left).toBeGreaterThanOrEqual(0);
  });

  it("fitWindow gives fractional-scale maximized windows a 2px slack", () => {
    // At 125% CDP rounds a maximized window outward: 2px too large is expected.
    const fit = fitWindow(
      { left: -6, top: -6, width: 1550, height: 839, windowState: "maximized" },
      { left: 0, top: 0, width: 1536, height: 826 },
      1.25,
    );
    expect(fit).toBeNull();
  });

  it("sizeAtScale stepping is applied when shrinking at fractional scale", () => {
    const fix = fitWindow(
      { left: 0, top: 0, width: 2000, height: 1200, windowState: "normal" },
      { left: 0, top: 0, width: 1536, height: 826 },
      1.25,
    );
    expect(fix).not.toBeNull();
    // The fitted width must read as <= 1536 at 125% after pixel rounding.
    expect(Math.ceil(Math.ceil(fix!.width * 1.25 - 1e-6) / 1.25 - 1e-6)).toBeLessThanOrEqual(1536);
  });

  it("initialWindowSize is smaller than the claimed screen but sane", () => {
    const size = initialWindowSize(null);
    expect(size.width).toBeLessThan(1920);
    expect(size.height).toBeLessThan(1080);
    expect(size.width).toBeGreaterThanOrEqual(320);
    expect(size.height).toBeGreaterThanOrEqual(240);
  });
});

/** Fake driver: script the windows list, record setBounds calls. */
function fakeDriver(windows: { windowId: number; bounds: WindowBounds }[]): {
  driver: WindowDriver;
  setCalls: { windowId: number; bounds: ScreenArea }[];
  setWindows(next: { windowId: number; bounds: WindowBounds }[]): void;
} {
  let current = windows;
  const setCalls: { windowId: number; bounds: ScreenArea }[] = [];
  return {
    setCalls,
    setWindows(next) {
      current = next;
    },
    driver: {
      async listWindows() {
        return current;
      },
      async setBounds(windowId, bounds) {
        setCalls.push({ windowId, bounds });
      },
    },
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("WindowFitWatcher", () => {
  it("shrinks an oversized window once and does not loop", async () => {
    const { driver, setCalls, setWindows } = fakeDriver([
      { windowId: 1, bounds: { left: 0, top: 0, width: 2560, height: 1440, windowState: "normal" } },
    ]);
    const watcher = new WindowFitWatcher(driver, AREA, { intervalMs: 25 });
    watcher.start();
    await wait(80);
    expect(setCalls.length).toBe(1);
    expect(setCalls[0]?.bounds).toEqual({ left: 0, top: 0, width: 1920, height: 1080 });

    // The fix didn't take (window manager refused, bounds unchanged):
    // no repeated setBounds for the same signature.
    await wait(120);
    expect(setCalls.length).toBe(1);

    // User drags the window oversized again (changed bounds re-arm the fix).
    setWindows([
      { windowId: 1, bounds: { left: 5, top: 5, width: 2500, height: 1300, windowState: "normal" } },
    ]);
    await wait(120);
    expect(setCalls.length).toBe(2);
    watcher.stop();
  });

  it("leaves fitting windows and fullscreen alone", async () => {
    const { driver, setCalls } = fakeDriver([
      { windowId: 1, bounds: { left: 10, top: 10, width: 1280, height: 800, windowState: "normal" } },
      { windowId: 2, bounds: { left: 0, top: 0, width: 3840, height: 2160, windowState: "fullscreen" } },
    ]);
    const watcher = new WindowFitWatcher(driver, AREA, { intervalMs: 25 });
    watcher.start();
    await wait(100);
    expect(setCalls.length).toBe(0);
    watcher.stop();
  });
});
