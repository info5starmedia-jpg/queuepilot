import { EventEmitter } from "node:events";
import type {
  BrowserRuntime,
  BrowserSession,
  LaunchRequest,
} from "./browser-runtime.js";

/**
 * Deterministic in-memory engine for tests, CI and demos. It models the
 * failure modes a real engine exhibits — launch failure, slow start, abrupt
 * crash — so lifecycle tests can exercise every path without a browser.
 *
 * Failure scripting is explicit: tests set failNextLaunch / crashAfterMs and
 * the fake honors them exactly once per configuration.
 */
export class FakeBrowserRuntime implements BrowserRuntime {
  readonly kind = "fake";
  failNextLaunch: string | null = null;
  launchDelayMs = 0;
  readonly sessions: FakeSession[] = [];
  private nextPid = 10_000;
  private nextPort = 92_200;

  async launch(request: LaunchRequest): Promise<BrowserSession> {
    if (this.launchDelayMs > 0) {
      await new Promise((r) => setTimeout(r, this.launchDelayMs));
    }
    if (this.failNextLaunch) {
      const message = this.failNextLaunch;
      this.failNextLaunch = null;
      throw new Error(message);
    }
    const session = new FakeSession(
      ++this.nextPid,
      ++this.nextPort,
      request.profile.id,
    );
    this.sessions.push(session);
    return session;
  }

  /** The fake runtime ships no binary — nothing to probe. */
  engineBinaryPath(): string | null {
    return null;
  }
}

export class FakeSession extends EventEmitter implements BrowserSession {
  readonly wsEndpoint: string;
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
  private resolveExit!: (v: {
    code: number | null;
    signal: string | null;
  }) => void;
  stopped = false;

  constructor(
    readonly pid: number,
    readonly debugPort: number,
    readonly profileId: string,
  ) {
    super();
    this.wsEndpoint = `ws://127.0.0.1:${debugPort}/devtools/browser/fake-${pid}`;
    this.exited = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  async stop(): Promise<void> {
    if (!this.stopped) {
      this.stopped = true;
      this.resolveExit({ code: 0, signal: null });
    }
  }

  /** Test hook: simulate the engine dying on its own. */
  crash(signal: string | null = "SIGTRAP"): void {
    if (!this.stopped) {
      this.stopped = true;
      this.resolveExit({ code: null, signal });
    }
  }
}
