import { proxyUrl } from "@queuepilot/contracts";
import type { FingerprintIdentity, Profile } from "@queuepilot/contracts";

/**
 * The engine port. The API never talks to a browser engine directly — only
 * through this interface — which is what lets the whole lifecycle be tested
 * deterministically against FakeBrowserRuntime while the real Camoufox
 * adapter implements the same contract.
 */
export interface LaunchRequest {
  profile: Profile;
  identity: FingerprintIdentity | null;
  /** Prebuilt --proxy-server value, or null for a direct connection. */
  proxyUrl: string | null;
  /** Directory the engine persists profile data to (cookies, storage). */
  profileDataDir: string;
}

export interface BrowserSession {
  readonly pid: number;
  readonly debugPort: number;
  readonly wsEndpoint: string;
  /** Resolve once the browser process has exited for any reason. */
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
  stop(): Promise<void>;
}

export interface BrowserRuntime {
  readonly kind: string;
  /**
   * Absolute path of the engine binary this runtime will execute, or null
   * when the runtime needs no binary (the fake runtime). Used by the engine
   * health probe; the path is reported, never modified.
   */
  engineBinaryPath?(): string | null;
  launch(request: LaunchRequest): Promise<BrowserSession>;
}

// Re-export so runtime adapters and the lifecycle share one helper.
export { proxyUrl };
