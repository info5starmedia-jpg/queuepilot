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

/** Human-account tiers on the hosted team server (apps/server auth-store). */
export type TeamTier = "L1" | "L2" | "L3" | "owner";

export interface TeamAccount {
  id: string;
  email: string;
  displayName: string;
  tier: TeamTier;
  active: boolean;
  createdAt: string;
}

export interface TeamInvite {
  id: string;
  role: TeamTier;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  usedByEmail: string | null;
}

/**
 * Token source (hosted sign-in, 2026-11-18): which bearer this machine sends.
 * A signed-in `qps_` session wins while it is unexpired; otherwise the
 * device token (Settings → Team → token) is used exactly as before. Null =
 * no credential, team mode is off.
 */
export function teamCredential(
  team: { token: string | null; sessionToken?: string | null; sessionExpiresAt?: string | null },
  now: number = Date.now(),
): { token: string; source: "session" | "device" } | null {
  if (team.sessionToken) {
    const exp = team.sessionExpiresAt ? Date.parse(team.sessionExpiresAt) : NaN;
    if (Number.isNaN(exp) || exp > now) return { token: team.sessionToken, source: "session" };
  }
  if (team.token) return { token: team.token, source: "device" };
  return null;
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
    const headers: Record<string, string> = this.token ? { authorization: `Bearer ${this.token}` } : {};
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

  /** Liveness probe without a token — `bundles` is present only for
   *  authenticated callers (audit 4b: unauthenticated /health is {ok} only). */
  async health(): Promise<{ ok: boolean; bundles?: number }> {
    const res = await fetch(this.url("/health"));
    if (!res.ok) throw new TeamServerError(res.status, "HTTP_ERROR", "health check failed");
    return (await res.json()) as { ok: boolean; bundles?: number };
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

  // ---- hosted accounts (2026-11-18) ----

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.req(
      method,
      path,
      body === undefined ? {} : { body: Buffer.from(JSON.stringify(body)), asJson: true },
    );
    return (await res.json()) as T;
  }

  /** Email+password sign-in. Public route — the token passed in is ignored. */
  static async signIn(
    baseUrl: string,
    email: string,
    password: string,
  ): Promise<{ token: string; expiresAt: string; account: TeamAccount }> {
    return new TeamServerClient(baseUrl, "").json("POST", "/auth/signin", { email, password });
  }

  async me(): Promise<{ account?: TeamAccount | null; device?: { role: string | null; name: string } }> {
    return this.json("GET", "/auth/me");
  }

  async signOut(): Promise<void> {
    await this.json("POST", "/auth/signout");
  }

  async listMembers(): Promise<{ members: TeamAccount[]; cap: number }> {
    return this.json("GET", "/team/members");
  }

  async updateMember(id: string, patch: { role?: TeamTier | undefined; active?: boolean | undefined }): Promise<{ account: TeamAccount; changed: boolean }> {
    return this.json("PATCH", `/team/members/${encodeURIComponent(id)}`, patch);
  }

  async removeMember(id: string): Promise<void> {
    await this.json("DELETE", `/team/members/${encodeURIComponent(id)}`);
  }

  async createInvite(role: TeamTier): Promise<{ code: string; invite: TeamInvite }> {
    return this.json("POST", "/team/invites", { role });
  }

  async listInvites(): Promise<{ invites: TeamInvite[] }> {
    return this.json("GET", "/team/invites");
  }

  async revokeInvite(id: string): Promise<void> {
    await this.json("DELETE", `/team/invites/${encodeURIComponent(id)}`);
  }
}
