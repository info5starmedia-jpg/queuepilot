import { proxyUrl } from "@queuepilot/contracts";
import type {
  FingerprintIdentity,
  ObservedFingerprint,
  Profile,
} from "@queuepilot/contracts";

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
  /**
   * Optional tab management. Present = the runtime can open/close tabs and
   * route each tab into a session partition by key (tabs sharing a key share
   * an in-memory session). Absent = the runtime launches browsers only; the
   * API answers TABS_UNSUPPORTED rather than pretending a tab exists.
   */
  openTab?(request: OpenTabRequest): Promise<{ engineTabId: string }>;
  closeTab?(engineTabId: string): Promise<void>;
  /** Optional per-tab ops (tab-ops depth). Absent = TABS_UNSUPPORTED. */
  reloadTab?(engineTabId: string): Promise<void>;
  /** PNG of the tab's current viewport. */
  screenshotTab?(engineTabId: string): Promise<Buffer>;
  /**
   * Optional fingerprint attestation. Present = the runtime can probe a live
   * page (over CDP or equivalent) and report what the engine ACTUALLY
   * materialized. Absent = the API answers ATTESTATION_UNSUPPORTED rather
   * than returning an unverified "match".
   */
  captureFingerprint?(): Promise<ObservedFingerprint>;
  /**
   * Optional egress facts measured at launch (relay port, exit address,
   * WebRTC keys). Present when the runtime fronts the proxy with a relay —
   * the diagnostics surface reads it. Absent = direct egress, nothing to
   * diagnose beyond "no proxy".
   */
  readonly egress?: EgressInfo | null | undefined;
}

/** Egress facts captured at launch for the diagnostics surface. */
export interface EgressInfo {
  relayPort: number | null;
  /** null = exit check failed; engine gathers no WebRTC candidates. */
  exitIp: string | null;
  webrtcPublicIp: string | null;
  webrtcHostName: string | null;
  checkedAt: string;
}

export interface OpenTabRequest {
  url: string | null;
  /** Session-partition routing key; equal keys = shared in-memory session. */
  partitionKey: string;
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
