import type {
  AttestationResult,
  BrowserRun,
  BrowserTab,
  EngineHealth,
  EngineSelfTestResult,
  IdentityDrift,
  Profile,
  ProfileProvider,
  Proxy,
  ProxyProvider,
  SessionPartition,
  TempProxyInput,
} from "@queuepilot/contracts";

/**
 * QueuePilotClient — the typed SDK for the native REST API.
 *
 * Zero dependencies: fetch only. Every method maps 1:1 to a route and returns
 * the contract types, so scripts and the dashboard share one source of truth.
 * Errors surface as ApiError with the server's stable error code.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ClientOptions {
  /** Bearer token matching SPECTRA_API_TOKEN, if set. */
  token?: string;
  fetcher?: typeof fetch;
}

export class QueuePilotClient {
  private readonly base: string;
  private readonly token?: string;
  private readonly fetcher: typeof fetch;

  constructor(baseUrl = "http://127.0.0.1:50325", opts: ClientOptions = {}) {
    this.base = baseUrl.replace(/\/$/, "");
    this.fetcher = opts.fetcher ?? fetch;
    if (opts.token !== undefined) this.token = opts.token;
  }

  /* profiles */
  listProfiles(filter: { group?: string; query?: string } = {}): Promise<{ profiles: Profile[] }> {
    const q = new URLSearchParams();
    if (filter.group) q.set("group", filter.group);
    if (filter.query) q.set("query", filter.query);
    const suffix = q.size ? `?${q}` : "";
    return this.get(`/profiles${suffix}`);
  }
  createProfile(input: { name: string; group?: string }): Promise<Profile> {
    return this.send("POST", "/profiles", input);
  }
  getProfile(id: string): Promise<Profile> {
    return this.get(`/profiles/${id}`);
  }
  deleteProfile(id: string): Promise<void> {
    return this.send("DELETE", `/profiles/${id}`);
  }

  /* lifecycle */
  start(profileId: string, opts: { tempProxy?: TempProxyInput } = {}): Promise<BrowserRun> {
    return this.send("POST", `/profiles/${profileId}/start`, opts.tempProxy ? { tempProxy: opts.tempProxy } : {});
  }
  stop(profileId: string): Promise<{ stopped: boolean; run: BrowserRun | null }> {
    return this.send("POST", `/profiles/${profileId}/stop`);
  }
  activeRun(profileId: string): Promise<{ run: BrowserRun | null }> {
    return this.get(`/profiles/${profileId}/run`);
  }
  drift(profileId: string): Promise<{ drift: IdentityDrift | null }> {
    return this.get(`/profiles/${profileId}/drift`);
  }

  /**
   * Fingerprint attestation: probe the live engine and compare what it
   * materialized against the launch snapshot. Throws ApiError with code
   * PROFILE_NOT_RUNNING (409) or ATTESTATION_UNSUPPORTED (501) when the
   * runtime cannot probe.
   */
  attest(profileId: string): Promise<AttestationResult> {
    return this.get(`/profiles/${profileId}/attest`);
  }

  /* tabs */
  openTab(profileId: string, input: { url?: string; relatedTo?: string } = {}): Promise<BrowserTab> {
    return this.send("POST", `/profiles/${profileId}/tabs`, input);
  }
  listTabs(profileId: string): Promise<{ tabs: BrowserTab[]; partitions: SessionPartition[] }> {
    return this.get(`/profiles/${profileId}/tabs`);
  }
  closeTab(profileId: string, tabId: string): Promise<{ closed: boolean; tab: BrowserTab }> {
    return this.send("POST", `/profiles/${profileId}/tabs/${tabId}/close`);
  }

  /* proxies */
  listProxies(): Promise<{ proxies: Proxy[] }> {
    return this.get("/proxies");
  }
  testProxy(id: string): Promise<{ ok: boolean; latencyMs: number | null; error: string | null }> {
    return this.send("POST", `/proxies/${id}/test`);
  }

  /* providers */
  listProfileProviders(): Promise<{ providers: ProfileProvider[] }> {
    return this.get("/profile-providers");
  }
  refreshProfileProvider(id: string): Promise<unknown> {
    return this.send("POST", `/profile-providers/${id}/refresh`);
  }
  listProxyProviders(): Promise<{ providers: ProxyProvider[] }> {
    return this.get("/proxy-providers");
  }
  nextProxy(providerId: string): Promise<{ proxy: Proxy }> {
    return this.send("POST", `/proxy-providers/${providerId}/next`);
  }

  /* engine */
  engineHealth(): Promise<EngineHealth> {
    return this.get("/engine/health");
  }
  engineSelfTest(): Promise<EngineSelfTestResult> {
    return this.send("POST", "/engine/self-test");
  }

  /* connection helpers */

  /**
   * Start a profile and return connection info ready for automation
   * libraries. `puppeteer`/`playwright` both speak CDP to the same endpoint:
   *   puppeteer.connect({ browserWSEndpoint: info.wsEndpoint })
   *   chromium.connectOverCDP(info.wsEndpoint)            (playwright)
   * For Firefox-family engines use playwright's firefox with the debug port.
   */
  async connect(profileId: string, opts: { tempProxy?: TempProxyInput } = {}): Promise<{
    run: BrowserRun;
    wsEndpoint: string;
    debugPort: number;
  }> {
    const run = await this.start(profileId, opts);
    if (!run.wsEndpoint || !run.debugPort) {
      throw new ApiError(500, "ENGINE_LAUNCH_FAILED", "engine returned no ws endpoint");
    }
    return { run, wsEndpoint: run.wsEndpoint, debugPort: run.debugPort };
  }

  /** Reuse an already-running profile's connection info. */
  async connectionInfo(profileId: string): Promise<{ wsEndpoint: string; debugPort: number } | null> {
    const { run } = await this.activeRun(profileId);
    if (!run?.wsEndpoint || !run.debugPort) return null;
    return { wsEndpoint: run.wsEndpoint, debugPort: run.debugPort };
  }

  /* transport */
  private get<T>(path: string): Promise<T> {
    return this.send<T>("GET", path);
  }

  private async send<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const res = await this.fetcher(`${this.base}${path}`, {
      method,
      headers,
      body: body === undefined ? null : JSON.stringify(body),
    });
    if (res.status === 204) return undefined as T;
    const data = (await res.json()) as { error?: { code: string; message: string } };
    if (!res.ok) {
      throw new ApiError(res.status, data.error?.code ?? "UNKNOWN", data.error?.message ?? `HTTP ${res.status}`);
    }
    return data as T;
  }
}
