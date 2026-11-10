import { CdpConnection } from "./cdp-connection.js";

interface CreateTargetResult {
  targetId: string;
}
interface AttachResult {
  sessionId: string;
}
interface EvaluateResult {
  result?: { type?: string; value?: unknown };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
}

/**
 * A session-scoped page probe: one throwaway about:blank target, flattened
 * attach, evaluate as many expressions as needed, always detached and closed
 * afterwards. This is the shared spine for attestation and the detection
 * claim suite — the claim code never touches connection lifecycle.
 */
export async function withPage<T>(
  wsEndpoint: string,
  pageUrl: string,
  fn: (page: PageProbe) => Promise<T>,
): Promise<T> {
  const conn = await CdpConnection.connect(wsEndpoint);
  let targetId: string | null = null;
  let sessionId: string | null = null;
  try {
    const created = await conn.call<CreateTargetResult>("Target.createTarget", {
      // Probe pages must be secure contexts: about:blank is NOT one, and
      // userAgentData / deviceMemory silently vanish there. Callers pass a
      // loopback URL (the engine's own debug HTTP endpoint) instead.
      url: pageUrl,
    });
    targetId = created.targetId;
    const attached = await conn.call<AttachResult>("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    sessionId = attached.sessionId;

    const page: PageProbe = {
      async evaluate(expression: string): Promise<unknown> {
        const r = await conn.call<EvaluateResult>(
          "Runtime.evaluate",
          {
            expression,
            returnByValue: true,
            awaitPromise: true,
            timeout: 10_000,
          },
          15_000,
          sessionId!,
        );
        if (r.exceptionDetails) {
          throw new Error(
            r.exceptionDetails.exception?.description ??
              r.exceptionDetails.text ??
              "page evaluation failed",
          );
        }
        return r.result?.value;
      },
    };
    return await fn(page);
  } finally {
    if (sessionId) {
      await conn
        .call("Target.detachFromTarget", { sessionId }, 5_000)
        .catch(() => {});
    }
    if (targetId) {
      await conn.call("Target.closeTarget", { targetId }, 5_000).catch(() => {});
    }
    conn.close();
  }
}

export interface PageProbe {
  /**
   * Evaluate an expression in the page; the result must be JSON-serializable
   * (returnByValue). Promises are awaited. A page-side throw is a probe
   * failure, not a claim failure.
   */
  evaluate(expression: string): Promise<unknown>;
}
