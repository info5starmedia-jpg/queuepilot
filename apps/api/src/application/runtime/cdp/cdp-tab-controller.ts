import { DomainError, ErrorCodes } from "@queuepilot/contracts";
import { CdpConnection, CdpError } from "./cdp-connection.js";

interface CreateBrowserContextResult {
  browserContextId: string;
}
interface CreateTargetResult {
  targetId: string;
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
    const result = await conn.call<CreateTargetResult>("Target.createTarget", {
      url: url ?? "about:blank",
      browserContextId,
      newWindow: false,
    });
    return { engineTabId: result.targetId };
  }

  async closeTab(engineTabId: string): Promise<void> {
    const conn = await this.ensureConnection();
    await conn.call("Target.closeTarget", { targetId: engineTabId });
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
