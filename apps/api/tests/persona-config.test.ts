import { describe, expect, it } from "vitest";
import { personaConfig } from "../src/application/runtime/fury-core.runtime.js";
import type { FingerprintIdentityWithOverrides } from "@queuepilot/contracts";

/**
 * Persona v2 engine pins (v0.16.0): the fury patchset reads
 * navigator.userAgent (0011), fonts/fontsHidden (0050-0052) and
 * gpu.webglParams.UNMASKED_* (0031) from the persona config. personaConfig
 * must emit EXACTLY those keys when pinned and omit them entirely when not —
 * absent keys mean "use the real value" on the engine side.
 */

const base: FingerprintIdentityWithOverrides = {
  id: "11111111-1111-4111-8111-111111111111",
  seed: 12345,
  platform: "windows",
  screenWidth: 1920,
  screenHeight: 1080,
  hardwareConcurrency: 8,
  deviceMemoryGb: 8,
  timezone: "America/Toronto",
  locale: "en-US",
  createdAt: "2026-11-16T00:00:00.000Z",
};

describe("personaConfig engine pins", () => {
  it("emits nothing extra when nothing is pinned", () => {
    const cfg = personaConfig(base) as Record<string, any>;
    expect(cfg.navigator.userAgent).toBeUndefined();
    expect(cfg.fonts).toBeUndefined();
    expect(cfg.fontsHidden).toBeUndefined();
    expect(cfg["gpu.webglParams"]).toBeUndefined();
    // Base mapping intact.
    expect(cfg.navigator.hardwareConcurrency).toBe(8);
    expect(cfg.navigator.platform).toBe("Win32");
  });

  it("pins reach the exact engine key paths", () => {
    const cfg = personaConfig({
      ...base,
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36",
      fonts: ["Arial", "Calibri", "Segoe UI"],
      fontsHidden: ["Wingdings"],
      webglVendor: "Google Inc. (NVIDIA)",
      webglRenderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0)",
    }) as Record<string, any>;

    expect(cfg.navigator.userAgent).toContain("Chrome/157");
    expect(cfg.fonts).toEqual(["Arial", "Calibri", "Segoe UI"]);
    expect(cfg.fontsHidden).toEqual(["Wingdings"]);
    expect(cfg["gpu.webglParams"].UNMASKED_VENDOR_WEBGL).toBe("Google Inc. (NVIDIA)");
    expect(cfg["gpu.webglParams"].UNMASKED_RENDERER_WEBGL).toContain("RTX 3060");
  });

  it("vendor-only or renderer-only pin still lands under gpu.webglParams", () => {
    const cfg = personaConfig({ ...base, webglVendor: "Google Inc. (Intel)" }) as Record<string, any>;
    expect(cfg["gpu.webglParams"]).toEqual({ UNMASKED_VENDOR_WEBGL: "Google Inc. (Intel)" });
  });

  it("null identity yields the bare schema shell", () => {
    expect(personaConfig(null)).toEqual({ schema_version: 1 });
  });
});
