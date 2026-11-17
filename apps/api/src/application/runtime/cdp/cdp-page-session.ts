import type { CdpConnection } from "./cdp-connection.js";

/**
 * Page-session attachment for browser-level CDP connections.
 *
 * Real Chromium (and the Firefox CDP-compat surface) only serve browser
 * domains (Target, Browser, Storage, …) on the browser WebSocket; page
 * domains (Network, Runtime, Page, …) require a session attached to a page
 * target (`Target.attachToTarget { flatten: true }`). Code that connected
 * to the browser endpoint and called `Network.*` directly used to fail with
 * "'Network.getAllCookies' wasn't found" — this helper is the one correct
 * path for those calls.
 *
 * The first open page target is reused; only when the browser has no page
 * at all is a transient `about:blank` target created (and closed on
 * release), so a cookie list never spawns a visible tab on a real profile.
 */

interface TargetInfo {
  targetId: string;
  type: string;
}

export interface PageSessionHandle {
  readonly sessionId: string;
  /** Detach the session; close the transient target if we created one. */
  release(): Promise<void>;
}

export async function attachPageSession(
  conn: CdpConnection,
  opts: { preferTargetId?: string } = {},
): Promise<PageSessionHandle> {
  let targetId = opts.preferTargetId;
  let created = false;
  if (!targetId) {
    const r = await conn.call<{ targetInfos?: TargetInfo[] }>("Target.getTargets", {}, 10_000);
    const page = (r.targetInfos ?? []).find((t) => t.type === "page");
    targetId = page?.targetId;
  }
  if (!targetId) {
    const c = await conn.call<{ targetId: string }>(
      "Target.createTarget",
      { url: "about:blank" },
      10_000,
    );
    targetId = c.targetId;
    created = true;
  }
  const attached = await conn.call<{ sessionId: string }>(
    "Target.attachToTarget",
    { targetId, flatten: true },
    10_000,
  );
  const sessionId = attached.sessionId;
  return {
    sessionId,
    async release() {
      await conn.call("Target.detachFromTarget", { sessionId }, 5_000).catch(() => {});
      if (created) {
        await conn.call("Target.closeTarget", { targetId }, 5_000).catch(() => {});
      }
    },
  };
}
