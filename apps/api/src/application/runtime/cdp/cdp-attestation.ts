import { DomainError, ErrorCodes, ObservedFingerprintSchema, type ObservedFingerprint } from "@queuepilot/contracts";
import { FINGERPRINT_PROBE_EXPRESSION } from "../../profiles/fingerprint-attestation.js";
import { CdpConnection } from "./cdp-connection.js";

interface CreateTargetResult {
  targetId: string;
}
interface AttachResult {
  sessionId: string;
}
interface EvaluateResult {
  result?: { type?: string; value?: unknown };
  exceptionDetails?: { text?: string };
}

/**
 * Capture the observed fingerprint of a live engine over CDP.
 *
 * Flow: create a throwaway about:blank target in the DEFAULT context (not a
 * session partition — attestation must not touch user tabs), attach with
 * flatten mode so Runtime.evaluate can be session-scoped, run the probe,
 * then detach and close the target even when the probe fails. The page never
 * navigates, so nothing about the probe is observable from the outside.
 */
export async function captureFingerprintViaCdp(
  wsEndpoint: string,
): Promise<ObservedFingerprint> {
  const conn = await CdpConnection.connect(wsEndpoint);
  let targetId: string | null = null;
  let sessionId: string | null = null;
  try {
    const created = await conn.call<CreateTargetResult>("Target.createTarget", {
      url: "about:blank",
    });
    targetId = created.targetId;
    const attached = await conn.call<AttachResult>("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    sessionId = attached.sessionId;

    const evaluated = await conn.call<EvaluateResult>(
      "Runtime.evaluate",
      { expression: FINGERPRINT_PROBE_EXPRESSION, returnByValue: true },
      15_000,
      sessionId,
    );
    if (evaluated.exceptionDetails) {
      throw new Error(
        `probe threw: ${evaluated.exceptionDetails.text ?? "unknown"}`,
      );
    }
    const value = evaluated.result?.value;
    if (!value || typeof value !== "object") {
      throw new Error("probe returned no object");
    }
    // Validate against the contract — an engine that answers with a
    // different shape is a bug we want loud, not coerced.
    return ObservedFingerprintSchema.parse(value);
  } finally {
    if (sessionId) {
      await conn
        .call("Target.detachFromTarget", { sessionId }, 5_000)
        .catch(() => {});
    }
    if (targetId) {
      await conn
        .call("Target.closeTarget", { targetId }, 5_000)
        .catch(() => {});
    }
    conn.close();
  }
}

/** Map any capture failure to a stable domain error for the HTTP layer. */
export function attestationUnsupported(kind: string, cause: unknown): DomainError {
  return new DomainError(
    ErrorCodes.ATTESTATION_UNSUPPORTED,
    `runtime "${kind}" could not capture a live fingerprint: ${
      cause instanceof Error ? cause.message : String(cause)
    }`,
  );
}
