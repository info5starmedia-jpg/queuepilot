import { DomainError, ErrorCodes } from "@queuepilot/contracts";
import type { SettingsService } from "../application/settings/settings.service.js";

/**
 * Audit A-rec #3 (v0.15.0): endpoints that RUN code (JYL commands/macros,
 * JYL module web endpoints, plugin/parser/resolver execution) or touch
 * secrets (alias writes) are refused unless the operator explicitly opted
 * in via Settings → Automation → "Scripting endpoints".
 *
 * Audit GPT-5.4 finding 1 (v0.16): the opt-in alone is not enough — the
 * same endpoints must also demand an auth boundary. When the app was built
 * WITHOUT an apiToken (SPECTRA_API_TOKEN unset), enabling scripting is
 * refused outright: an RCE surface reachable from a profile browser with
 * no credential requirement at all is the exact hole the audit flagged.
 * The dashboard toggle is refused at the settings route too, and main.ts
 * logs a loud startup warning, so the only way to reach this state is
 * bypassing HTTP entirely. Fails CLOSED when no settings store is wired.
 */
export function scriptingGate(
  settings: SettingsService | undefined,
  opts: { hasApiToken: boolean },
): () => void {
  return () => {
    const on = settings?.get("automation").scriptingEndpoints === true;
    if (!on) {
      throw new DomainError(
        ErrorCodes.FORBIDDEN,
        "scripting endpoints are disabled — enable Settings → Automation → Scripting endpoints first",
      );
    }
    if (!opts.hasApiToken) {
      throw new DomainError(
        ErrorCodes.FORBIDDEN,
        "scripting endpoints require SPECTRA_API_TOKEN — set the env var and restart the API before enabling them",
      );
    }
  };
}
