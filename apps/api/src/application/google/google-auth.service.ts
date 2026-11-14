import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { DomainError, ErrorCodes } from "@queuepilot/contracts";
import type { SecretStore } from "../secrets/secret-store.js";

/**
 * Google OAuth (loopback desktop flow, authorization-code + PKCE) — ONE
 * service for every Google surface: Sheets providers and the gmail resolver.
 *
 * - Multi-account: each account has its own token set under
 *   `google.oauth.<account>` in the SecretStore (DPAPI machine-bound — the
 *   refresh token never leaves the machine in plaintext).
 * - Per-account scopes: sheets connects with spreadsheets.readonly, gmail
 *   with gmail.readonly; consent is per account+scope set.
 * - Pending authorizations persist to <dataDir>/google/oauth-pending.json so
 *   an API restart mid-flow doesn't lose the PKCE verifier.
 *
 * Client credentials come from env (SPECTRA_GOOGLE_CLIENT_ID /
 * SPECTRA_GOOGLE_CLIENT_SECRET). Endpoints and fetcher are injectable so
 * tests never touch the network.
 */

export const SHEETS_SCOPE =
  "https://www.googleapis.com/auth/spreadsheets.readonly";
export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
/** The account Sheets providers use. */
export const SHEETS_ACCOUNT = "sheets";

const GoogleTokenSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  /** ISO time when the access token expires. */
  expiresAt: z.string().datetime(),
  scope: z.string(),
});
export type GoogleToken = z.infer<typeof GoogleTokenSchema>;

export interface GoogleEndpoints {
  auth: string;
  token: string;
}

const DEFAULT_ENDPOINTS: GoogleEndpoints = {
  auth: "https://accounts.google.com/o/oauth2/v2/auth",
  token: "https://oauth2.googleapis.com/token",
};

interface PendingAuth {
  account: string;
  scopes: string[];
  verifier: string;
  expiresAt: number;
}

export interface GoogleAuthDeps {
  secrets: SecretStore;
  dataDir: string;
  clientId: string | null;
  clientSecret: string | null;
  /** Loopback redirect, e.g. http://127.0.0.1:50325/google/auth/callback */
  redirectUri: string;
  endpoints?: GoogleEndpoints;
  fetcher?: typeof fetch;
}

export class GoogleAuthService {
  private readonly endpoints: GoogleEndpoints;
  private readonly fetcher: typeof fetch;
  private readonly pendingFile: string;
  private readonly accountsFile: string;
  private readonly pending = new Map<string, PendingAuth>();

  constructor(private readonly deps: GoogleAuthDeps) {
    this.endpoints = deps.endpoints ?? DEFAULT_ENDPOINTS;
    this.fetcher = deps.fetcher ?? fetch;
    this.pendingFile = path.join(deps.dataDir, "google", "oauth-pending.json");
    this.accountsFile = path.join(deps.dataDir, "google", "accounts.json");
    if (fs.existsSync(this.pendingFile)) {
      try {
        const raw = JSON.parse(
          fs.readFileSync(this.pendingFile, "utf8"),
        ) as Record<string, PendingAuth>;
        for (const [state, p] of Object.entries(raw)) {
          if (p.expiresAt > Date.now()) this.pending.set(state, p);
        }
      } catch {
        /* corrupt pending file: start fresh */
      }
    }
  }

  configured(): boolean {
    return !!this.deps.clientId;
  }

  private assertConfigured(): void {
    if (!this.configured()) {
      throw new DomainError(
        ErrorCodes.GOOGLE_NOT_CONFIGURED,
        "set SPECTRA_GOOGLE_CLIENT_ID and SPECTRA_GOOGLE_CLIENT_SECRET to connect Google",
      );
    }
  }

  /** Begin a flow: the URL to open in a browser profile. 10 min expiry. */
  start(account: string, scopes: string[]): { url: string; state: string } {
    this.assertConfigured();
    const state = randomBytes(16).toString("hex");
    const verifier = randomBytes(48).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    this.pending.set(state, {
      account,
      scopes,
      verifier,
      expiresAt: Date.now() + 10 * 60_000,
    });
    this.persistPending();
    const params = new URLSearchParams({
      client_id: this.deps.clientId!,
      redirect_uri: this.deps.redirectUri,
      response_type: "code",
      scope: scopes.join(" "),
      access_type: "offline",
      prompt: "consent",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    return { url: `${this.endpoints.auth}?${params.toString()}`, state };
  }

  /** Finish a flow: exchange the code, persist tokens under the account. */
  async complete(state: string, code: string): Promise<{ account: string }> {
    this.assertConfigured();
    const p = this.pending.get(state);
    if (!p || p.expiresAt < Date.now()) {
      throw new DomainError(
        ErrorCodes.GOOGLE_NOT_CONNECTED,
        "oauth state expired or unknown — start the flow again",
      );
    }
    this.pending.delete(state);
    this.persistPending();
    const data = await this.tokenRequest({
      code,
      redirect_uri: this.deps.redirectUri,
      grant_type: "authorization_code",
      code_verifier: p.verifier,
    });
    if (!data.refresh_token) {
      throw new DomainError(
        ErrorCodes.GOOGLE_NOT_CONNECTED,
        "Google returned no refresh token (access_type=offline + prompt=consent required)",
      );
    }
    this.saveToken(p.account, {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: new Date(
        Date.now() + (data.expires_in ?? 3600) * 1000,
      ).toISOString(),
      scope: p.scopes.join(" "),
    });
    this.recordAccount(p.account);
    return { account: p.account };
  }

  /** Accounts that have completed at least one flow. */
  accounts(): string[] {
    if (!fs.existsSync(this.accountsFile)) return [];
    try {
      return (JSON.parse(fs.readFileSync(this.accountsFile, "utf8")) as string[]).slice().sort();
    } catch {
      return [];
    }
  }

  /** A valid access token for the account, refreshing when expired. */
  async accessToken(account: string): Promise<string> {
    this.assertConfigured();
    const token = this.loadToken(account);
    if (!token) {
      throw new DomainError(
        ErrorCodes.GOOGLE_NOT_CONNECTED,
        `Google account "${account}" is not connected — visit /google/auth/url?account=${encodeURIComponent(account)} and complete the flow`,
      );
    }
    if (Date.parse(token.expiresAt) - Date.now() > 60_000) {
      return token.accessToken;
    }
    const data = await this.tokenRequest({
      refresh_token: token.refreshToken,
      grant_type: "refresh_token",
    });
    const next: GoogleToken = {
      ...token,
      accessToken: data.access_token,
      expiresAt: new Date(
        Date.now() + (data.expires_in ?? 3600) * 1000,
      ).toISOString(),
    };
    this.saveToken(account, next);
    return next.accessToken;
  }

  /** Back-compat alias for the Sheets surface. */
  getAccessToken(): Promise<string> {
    return this.accessToken(SHEETS_ACCOUNT);
  }

  disconnect(account: string): void {
    this.deps.secrets.delete(this.key(account));
    const accounts = new Set(this.accounts());
    accounts.delete(account);
    fs.mkdirSync(path.dirname(this.accountsFile), { recursive: true });
    fs.writeFileSync(this.accountsFile, JSON.stringify([...accounts].sort()));
  }

  status(): {
    configured: boolean;
    connected: boolean;
    accounts: string[];
    expiresAt: string | null;
  } {
    const accounts = this.configured() ? this.accounts() : [];
    return {
      configured: this.configured(),
      connected: accounts.length > 0,
      accounts,
      expiresAt: accounts[0]
        ? (this.loadToken(accounts[0]!)?.expiresAt ?? null)
        : null,
    };
  }

  private async tokenRequest(
    params: Record<string, string>,
  ): Promise<{
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  }> {
    const body = new URLSearchParams({
      client_id: this.deps.clientId!,
      ...params,
    });
    if (this.deps.clientSecret) body.set("client_secret", this.deps.clientSecret);
    const res = await this.fetcher(this.endpoints.token, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!res.ok) {
      throw new DomainError(
        ErrorCodes.GOOGLE_NOT_CONNECTED,
        `token request failed: HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`,
      );
    }
    return (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };
  }

  private key(account: string): string {
    return `google.oauth.${account}`;
  }

  private loadToken(account: string): GoogleToken | null {
    const raw = this.deps.secrets.get(this.key(account));
    if (!raw) return null;
    try {
      return GoogleTokenSchema.parse(JSON.parse(raw));
    } catch {
      return null; // corrupt token = treat as disconnected
    }
  }

  private saveToken(account: string, token: GoogleToken): void {
    this.deps.secrets.set(this.key(account), JSON.stringify(GoogleTokenSchema.parse(token)));
  }

  private recordAccount(account: string): void {
    const accounts = new Set(this.accounts());
    accounts.add(account);
    fs.mkdirSync(path.dirname(this.accountsFile), { recursive: true });
    fs.writeFileSync(this.accountsFile, JSON.stringify([...accounts].sort()));
  }

  private persistPending(): void {
    fs.mkdirSync(path.dirname(this.pendingFile), { recursive: true });
    fs.writeFileSync(
      this.pendingFile,
      JSON.stringify(Object.fromEntries(this.pending)),
    );
  }
}
