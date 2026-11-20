/**
 * TeamServerClient — the machine-side half of P7.7a. Speaks to the self-hosted
 * team server (apps/server) over plain fetch: bearer-token auth, sealed
 * bundle bytes in, sealed bundle bytes out. The client never transmits a
 * passphrase — bundles are AES-256-GCM sealed before they reach this layer.
 *
 * Deliberately dependency-light (fetch + Buffer) so it can run inside the
 * API process, the CLI, or a future background sync loop (P7.7c) unchanged.
 */

export class TeamServerError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Server revision on a 409 — lets the caller pull+rebase and retry. */
    readonly currentRevision?: number,
  ) {
    super(message);
    this.name = "TeamServerError";
  }
}

export interface TeamLicence {
  account: { id: string; name: string };
  role: string;
  expiresAt: string | null;
  daysLeft: number | null;
}

export interface TeamBundleHead {
  profileId: string;
  revision: number;
  updatedBy: string;
  updatedAt: string;
  size: number;
}

export interface TeamPullResult {
  payload: Buffer;
  revision: number;
  updatedBy: string;
  updatedAt: string;
}

export class TeamServerClient {
  /** Builds a client from the `team` settings section, or null when unconfigured. */
  static fromSettings(team: { serverUrl?: string | null; token?: string | null }): TeamServerClient | null {
    return team.serverUrl && team.token ? new TeamServerClient(team.serverUrl, team.token) : null;
  }

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private url(path: string, query?: Record<string, string | number>): string {
    const u = new URL(path, this.baseUrl.endsWith("/") ? this.baseUrl : `${this.baseUrl}/`);
    for (const [k, v] of Object.entries(query ?? {})) u.searchParams.set(k, String(v));
    return u.toString();
  }

  private async req(
    method: string,
    path: string,
    opts: { body?: Buffer; query?: Record<string, string | number>; asJson?: boolean } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}` };
    // redirect: "error": a hostile or moved server cannot bounce us to another host.
    const init: RequestInit = { method, headers, redirect: "error" };
    if (opts.body) {
      headers["content-type"] = opts.asJson ? "application/json" : "application/octet-stream";
      init.body = opts.asJson ? opts.body.toString("utf8") : opts.body;
    }
    const res = await fetch(this.url(path, opts.query), init);
    if (!res.ok) {
      let code = "HTTP_ERROR";
      let message = `${method} ${path} → ${res.status}`;
      let currentRevision: number | undefined;
      try {
        const parsed = (await res.json()) as {
          error?: { code?: string; message?: string; currentRevision?: number };
        };
        code = parsed.error?.code ?? code;
        message = parsed.error?.message ?? message;
        currentRevision = parsed.error?.currentRevision;
      } catch {
        // non-JSON error body — keep the status-line message
      }
      throw new TeamServerError(res.status, code, message, currentRevision);
    }
    return res;
  }

  /** Liveness probe without a token — `bundles` is present only for
   *  authenticated callers (audit 4b: unauthenticated /health is {ok} only). */
  async health(): Promise<{ ok: boolean; bundles?: number }> {
    const res = await fetch(this.url("/health"));
    if (!res.ok) throw new TeamServerError(res.status, "HTTP_ERROR", "health check failed");
    return (await res.json()) as { ok: boolean; bundles?: number };
  }

  /** LIC: the licence this key belongs to (account, role, expiry). */
  async licence(): Promise<TeamLicence> {
    const res = await this.req("GET", "/licence");
    const j = (await res.json()) as Partial<TeamLicence>;
    // Pass on only the expected fields, whatever the server sent.
    return {
      account: { id: String(j.account?.id ?? ""), name: String(j.account?.name ?? "") },
      role: String(j.role ?? ""),
      expiresAt: typeof j.expiresAt === "string" ? j.expiresAt : null,
      daysLeft: typeof j.daysLeft === "number" ? j.daysLeft : null,
    };
  }

  // ---- W2: server-side warmup planning (implements RemoteWarmup) ----

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.req(method, path, body === undefined ? {} : { body: Buffer.from(JSON.stringify(body), "utf8"), asJson: true });
    return (await res.json()) as T;
  }

  async warmupPersonas(): Promise<{ id: string; name: string; description: string | null; sites: number }[]> {
    return (await this.json<{ personas: { id: string; name: string; description: string | null; sites: number }[] }>("GET", "/warmup/personas")).personas;
  }

  async warmupSites(personaId: string): Promise<{
    sites: { url: string; host: string; category: string; pool: string; excluded: boolean }[];
    added: unknown[];
    excluded: string[];
  }> {
    return this.json("GET", `/warmup/personas/${encodeURIComponent(personaId)}/sites`);
  }

  async putWarmupSites(personaId: string, body: unknown): Promise<{ excluded: string[]; added: never[] }> {
    return this.json("PUT", `/warmup/personas/${encodeURIComponent(personaId)}/sites`, body);
  }

  async warmupPlan(req: { persona?: string; sessions: number; country?: string; target: string }): Promise<{ personaId: string; sessions: never[] }> {
    return this.json("POST", "/warmup/plan", req);
  }

  async listBundles(): Promise<TeamBundleHead[]> {
    const res = await this.req("GET", "/bundles");
    const body = (await res.json()) as { bundles: TeamBundleHead[] };
    return body.bundles;
  }

  async pullBundle(profileId: string): Promise<TeamPullResult> {
    const res = await this.req("GET", `/bundles/${encodeURIComponent(profileId)}`);
    const payload = Buffer.from(await res.arrayBuffer());
    return {
      payload,
      revision: Number(res.headers.get("x-revision") ?? 0),
      updatedBy: res.headers.get("x-updated-by") ?? "unknown",
      updatedAt: res.headers.get("x-updated-at") ?? "",
    };
  }

  /** Push sealed bytes. Pass the revision you based this push on for optimistic concurrency. */
  async pushBundle(
    profileId: string,
    payload: Buffer,
    baseRevision?: number,
  ): Promise<{ revision: number }> {
    const opts: { body: Buffer; query?: Record<string, string | number> } = { body: payload };
    if (baseRevision !== undefined) opts.query = { baseRevision };
    const res = await this.req("PUT", `/bundles/${encodeURIComponent(profileId)}`, opts);
    return (await res.json()) as { revision: number };
  }

  async deleteBundle(profileId: string): Promise<void> {
    await this.req("DELETE", `/bundles/${encodeURIComponent(profileId)}`);
  }

  // ---- launch leases (P7.7b) ----

  /** Throws TeamServerError(409, LEASE_HELD) when another machine holds it. */
  async acquireLease(
    profileId: string,
    holder: string,
    machine: string,
    ttlMs?: number,
  ): Promise<{ expiresAt: string }> {
    const res = await this.req("POST", "/leases/acquire", {
      body: Buffer.from(JSON.stringify({ profileId, holder, machine, ttlMs })),
      asJson: true,
    });
    return (await res.json()) as { expiresAt: string };
  }

  async renewLease(
    profileId: string,
    holder: string,
    ttlMs?: number,
  ): Promise<{ expiresAt: string }> {
    const res = await this.req("POST", "/leases/renew", {
      body: Buffer.from(JSON.stringify({ profileId, holder, ttlMs })),
      asJson: true,
    });
    return (await res.json()) as { expiresAt: string };
  }

  async releaseLease(profileId: string, holder: string): Promise<boolean> {
    const res = await this.req("POST", "/leases/release", {
      body: Buffer.from(JSON.stringify({ profileId, holder })),
      asJson: true,
    });
    return ((await res.json()) as { released: boolean }).released;
  }

  /** Admin force-release: evicts a stuck lease without being the holder. */
  async forceReleaseLease(profileId: string): Promise<void> {
    await this.req("DELETE", `/leases/${encodeURIComponent(profileId)}`);
  }
}
