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
    const init: RequestInit = { method, headers };
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

  async health(): Promise<{ ok: boolean; bundles: number }> {
    const res = await fetch(this.url("/health"));
    if (!res.ok) throw new TeamServerError(res.status, "HTTP_ERROR", "health check failed");
    return (await res.json()) as { ok: boolean; bundles: number };
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
}
