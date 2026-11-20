import { DomainError, ErrorCodes } from "@queuepilot/contracts";
import { CdpConnection, CdpError } from "./cdp-connection.js";

interface CreateBrowserContextResult {
  browserContextId: string;
}
interface CreateTargetResult {
  targetId: string;
}
interface TargetInfo {
  targetId: string;
  type: string;
  url: string;
  browserContextId?: string;
}

/**
 * CdpTabController — engine-side tab routing over CDP.
 *
 * Partition isolation is real, not bookkeeping: each QueuePilot session
 * partition maps to a CDP *browser context* (Firefox's contextual-identity
 * equivalent exposed for Puppeteer compatibility). Contexts are created once
 * per partition key and reused; tabs are targets inside a context.
 *
 * Honesty rule: if the engine doesn't implement Target.createBrowserContext,
 * we throw TABS_UNSUPPORTED — we never silently open a tab in the shared
 * default context and claim it's isolated.
 */
export class CdpTabController {
  private connection: Promise<CdpConnection> | null = null;
  private readonly contexts = new Map<string, string>(); // partitionKey -> browserContextId

  /**
   * @param wsEndpoint fallback browser-level WebSocket endpoint
   * @param discoverEndpoint optional resolver (e.g. /json/version) for engines
   *        whose browser-level debugger URL carries a session path
   */
  constructor(
    private readonly wsEndpoint: string,
    private readonly discoverEndpoint?: () => Promise<string>,
  ) {}

  async openTab(
    url: string | null,
    partitionKey: string,
  ): Promise<{ engineTabId: string }> {
    const conn = await this.ensureConnection();
    const browserContextId = await this.contextFor(conn, partitionKey);
    const target = {
      url: url ?? "about:blank",
      browserContextId,
    };
    try {
      const result = await conn.call<CreateTargetResult>("Target.createTarget", {
        ...target,
        newWindow: false,
      });
      return { engineTabId: result.targetId };
    } catch (err) {
      // Chromium answers "no browser is open" when asked for a tab while no
      // window exists (e.g. engine launched straight to about:blank and the
      // window was closed). Opening a window+tab is the same partition —
      // retry honestly instead of failing the tab.
      if (err instanceof Error && /no browser is open/i.test(err.message)) {
        const result = await conn.call<CreateTargetResult>(
          "Target.createTarget",
          { ...target, newWindow: true },
        );
        return { engineTabId: result.targetId };
      }
      throw err;
    }
  }

  async closeTab(engineTabId: string): Promise<void> {
    const conn = await this.ensureConnection();
    await conn.call("Target.closeTarget", { targetId: engineTabId });
  }

  /**
   * Close the engine's startup blank tab (the window anchor Chromium opens
   * when launched without URL arguments). Only fires when it is unambiguous:
   * exactly one page target sitting on about:blank / the new-tab page OUTSIDE
   * the partition contexts we created, and at least one other page exists.
   * Without this, every launch shows a stray blank tab next to the tracked
   * start-page tabs (found live 2026-11-20 when start URLs moved off the CLI).
   * Note: fury-core gives EVERY tab its own browser context — the anchor has
   * an engine-created contextId, so "default context" is never the right test.
   */
  async closeInitialBlankTab(): Promise<boolean> {
    const conn = await this.ensureConnection();
    const { targetInfos } = await conn.call<{ targetInfos: TargetInfo[] }>(
      "Target.getTargets",
      {},
    );
    const pages = targetInfos.filter((t) => t.type === "page");
    if (pages.length <= 1) return false;
    const ours = new Set(this.contexts.values());
    const blanks = pages.filter(
      (t) =>
        (t.url === "about:blank" ||
          /^chrome:\/\/(newtab|new-tab-page)\/?$/.test(t.url)) &&
        (!t.browserContextId || !ours.has(t.browserContextId)),
    );
    if (blanks.length !== 1) return false;
    await conn.call("Target.closeTarget", { targetId: blanks[0]!.targetId });
    return true;
  }

  /** Reload a tab (Page.reload on its attached page session). */
  async reloadTab(engineTabId: string, opts: { hard?: boolean } = {}): Promise<void> {
    await this.onTarget(engineTabId, (call) => call("Page.reload", { ignoreCache: opts.hard === true }));
  }

  async navigateTab(engineTabId: string, url: string): Promise<void> {
    await this.onTarget(engineTabId, (call) => call("Page.navigate", { url }));
  }

  async focusTab(engineTabId: string): Promise<void> {
    await this.onTarget(engineTabId, (call) => call("Page.bringToFront", {}));
  }

  /** PNG of the tab's viewport (Page.captureScreenshot). */
  async screenshotTab(engineTabId: string): Promise<Buffer> {
    const result = await this.onTarget(engineTabId, (call) =>
      call<{ data: string }>("Page.captureScreenshot", { format: "png" }),
    );
    return Buffer.from(result.data, "base64");
  }

  /**
   * Page-domain methods only answer on an attached page session — the
   * browser-level socket rejects them (README "CDP session discipline").
   * Attach (flatten), run, always detach.
   */
  private async onTarget<T>(
    targetId: string,
    fn: (call: <R>(method: string, params: Record<string, unknown>) => Promise<R>) => Promise<T>,
  ): Promise<T> {
    const conn = await this.ensureConnection();
    const { sessionId } = await conn.call<{ sessionId: string }>("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    try {
      return await fn((method, params) => conn.call(method, params, 15_000, sessionId));
    } finally {
      await conn.call("Target.detachFromTarget", { sessionId }).catch(() => {});
    }
  }

  /** Release every context we created and drop the connection. */
  async dispose(): Promise<void> {
    const connPromise = this.connection;
    this.connection = null;
    const contexts = [...this.contexts.values()];
    this.contexts.clear();
    if (!connPromise) return;
    try {
      const conn = await connPromise;
      for (const browserContextId of contexts) {
        try {
          await conn.call(
            "Target.disposeBrowserContext",
            { browserContextId },
            5_000,
          );
        } catch {
          // Best effort — the engine may already be shutting down.
        }
      }
      conn.close();
    } catch {
      // Connection never came up; nothing to dispose.
    }
  }

  /**
   * Engines take a moment to open their debug port after spawn, so connect
   * with a short retry loop instead of failing the first tab on a cold start.
   */
  private async ensureConnection(): Promise<CdpConnection> {
    if (!this.connection) {
      this.connection = (async () => {
        const endpoint = this.discoverEndpoint
          ? await this.discoverEndpoint()
          : this.wsEndpoint;
        let lastError: unknown = null;
        for (let attempt = 0; attempt < 10; attempt++) {
          try {
            return await CdpConnection.connect(endpoint, 3_000);
          } catch (err) {
            lastError = err;
            await new Promise((r) => setTimeout(r, 300));
          }
        }
        throw lastError instanceof Error
          ? lastError
          : new Error(`CDP connect failed: ${String(lastError)}`);
      })();
      // A failed connect must not poison future attempts.
      this.connection.catch(() => {
        this.connection = null;
      });
    }
    return this.connection;
  }

  private async contextFor(
    conn: CdpConnection,
    partitionKey: string,
  ): Promise<string> {
    const existing = this.contexts.get(partitionKey);
    if (existing) return existing;
    try {
      const result = await conn.call<CreateBrowserContextResult>(
        "Target.createBrowserContext",
        { disposeOnDetach: true },
      );
      this.contexts.set(partitionKey, result.browserContextId);
      return result.browserContextId;
    } catch (err) {
      if (
        err instanceof CdpError &&
        (err.code === -32601 || /method/i.test(err.message))
      ) {
        throw new DomainError(
          ErrorCodes.TABS_UNSUPPORTED,
          `engine does not support isolated browser contexts (Target.createBrowserContext): ${err.message}`,
        );
      }
      throw err;
    }
  }
}
