import type {
  AttestationVerdict,
  FingerprintDifference,
  FingerprintIdentity,
  ObservedFingerprint,
} from "@queuepilot/contracts";

/**
 * Fingerprint attestation — pure comparison, no browser, no I/O.
 *
 * The launch snapshot records what we ASKED the engine to materialize
 * (FingerprintIdentity). The observed fingerprint is what a live page probe
 * actually READ BACK. This module compares the two. Keeping it pure means the
 * verdict logic is testable without an engine — only the probe needs a browser.
 *
 * Comparison policy: a field only counts when the identity declares it AND
 * the probe could observe it (non-null). A probe that can't see WebGL, for
 * example, must not manufacture a mismatch — absence of evidence is reported
 * as null, not as disagreement.
 */
export function compareFingerprint(
  identity: FingerprintIdentity | null,
  observed: ObservedFingerprint,
): { verdict: AttestationVerdict; differences: FingerprintDifference[] } {
  if (!identity) return { verdict: "unattested", differences: [] };

  const differences: FingerprintDifference[] = [];
  const check = (
    field: string,
    expected: string | number | null,
    observedValue: string | number | null,
  ) => {
    if (expected === null || observedValue === null) return;
    if (String(expected) !== String(observedValue)) {
      differences.push({
        field,
        expected: String(expected),
        observed: String(observedValue),
      });
    }
  };

  check("screenWidth", identity.screenWidth, observed.screenWidth);
  check("screenHeight", identity.screenHeight, observed.screenHeight);
  check(
    "hardwareConcurrency",
    identity.hardwareConcurrency,
    observed.hardwareConcurrency,
  );
  check("deviceMemory", identity.deviceMemoryGb, observed.deviceMemory);
  check("timezone", identity.timezone, observed.timezone);
  // Locale: identity "en-US" vs probe languages ["en-US","en"] — the primary
  // language must match; regional fallbacks are engine detail.
  check("locale", identity.locale, observed.languages[0] ?? observed.locale);

  return {
    verdict: differences.length ? "mismatch" : "match",
    differences,
  };
}

/**
 * The page probe, evaluated via Runtime.evaluate with returnByValue. One
 * IIFE, no globals leaked, every sub-probe guarded so a single failure
 * degrades that field to null instead of failing the whole attestation.
 */
export const FINGERPRINT_PROBE_EXPRESSION = `(() => {
  const out = {
    userAgent: navigator.userAgent,
    platform: navigator.platform || "",
    languages: Array.from(navigator.languages || [navigator.language]),
    hardwareConcurrency: navigator.hardwareConcurrency ?? null,
    deviceMemory: navigator.deviceMemory ?? null,
    screenWidth: screen.width,
    screenHeight: screen.height,
    colorDepth: screen.colorDepth ?? null,
    timezone: null,
    locale: navigator.language || null,
    webglVendor: null,
    webglRenderer: null,
  };
  try {
    out.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {}
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
    if (gl) {
      const dbg = gl.getExtension("WEBGL_debug_renderer_info");
      if (dbg) {
        out.webglVendor = String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL));
        out.webglRenderer = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL));
      }
    }
  } catch {}
  return out;
})()`;
