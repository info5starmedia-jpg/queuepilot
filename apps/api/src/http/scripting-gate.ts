import { DomainError, ErrorCodes } from "@queuepilot/contracts";
import type { SettingsService } from "../application/settings/settings.service.js";

/**
 * Audit A-rec #3 (v0.15.0): endpoints that RUN code (JYL commands/macros,
 * JYL module web endpoints, plugin/parser/resolver execution) or touch
 * secrets (alias writes) are refused unless the operator explicitly opted
 * in via Settings → Automation → "Scripting endpoints". The bearer-token
 * hook (when SPECTRA_API_TOKEN is configured) is the auth half of the
 * gate; this setting is the explicit opt-in half. Fails CLOSED when no
 * settings store is wired.
 */
export function scriptingGate(
  settings: SettingsService | undefined,
): () => void {
  return () => {
    const on = settings?.get("automation").scriptingEndpoints === true;
    if (!on) {
      throw new DomainError(
        ErrorCodes.FORBIDDEN,
        "scripting endpoints are disabled — enable Settings → Automation → Scripting endpoints first",
      );
    }
  };
}
