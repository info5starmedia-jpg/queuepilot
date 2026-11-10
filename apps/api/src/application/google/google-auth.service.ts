import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { DomainError, ErrorCodes } from "@queuepilot/contracts";

/**
 * Google OAuth (loopback desktop flow) for Google Sheets providers.
 *
 * Client credentials come from env (SPECTRA_GOOGLE_CLIENT_ID /
 * SPECTRA_GOOGLE_CLIENT_SECRET) — a Google Cloud project with the Sheets API
 * enabled. The token file lives under <dataDir>/google/token.json, written
 * atomically; the refresh token never leaves the data dir. Endpoints and the
 * fetch implementation are injectable so tests never touch the network.
 */

export const SHEETS_SCOPE =
  "https://www.googleapis.com/auth/spreadsheets.readonly";

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

export interface GoogleAuthDeps {
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
  private readonly tokenFile: string;

  constructor(private readonly deps: GoogleAuthDeps) {
    this.endpoints = deps.endpoints ?? DEFAULT_ENDPOINTS;
    this.fetcher = deps.fetcher ?? fetch;
    this.tokenFile = path.join(deps.dataDir, "google", "token.json");
  }

  configured(): boolean {
    return !!(this.deps.clientId && this.deps.clientSecret);
  }

  /** The URL the user opens in their browser to connect Google. */
  authUrl(state: string): string {
    if (!this.configured()) {
      throw new DomainError(
        ErrorCodes.GOOGLE_NOT_CONFIGURED,
        "set SPECTRA_GOOGLE_CLIENT_ID and SPECTRA_GOOGLE_CLIENT_SECRET to connect Google",
      );
    }
    const params = new URLSearchParams({
      client_id: this.deps.clientId!,
      redirect_uri: this.deps.redirectUri,
      response_type: "code",
      scope: SHEETS_SCOPE,
      access_type: "offline",
      prompt: "consent",
      state,
    });
    return `${this.endpoints.auth}?${params.toString()}`;
  }

  /** Exchange the callback code for tokens and persist them. */
  async handleCallback(code: string): Promise<void> {
    if (!this.configured()) {
      throw new DomainError(
        ErrorCodes.GOOGLE_NOT_CONFIGURED,
        "set SPECTRA_GOOGLE_CLIENT_ID and SPECTRA_GOOGLE_CLIENT_SECRET to connect Google",
      );
    }
    const res = await this.fetcher(this.endpoints.token, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: this.deps.clientId!,
        client_secret: this.deps.clientSecret!,
        redirect_uri: this.deps.redirectUri,
        grant_type: "authorization_code",
      }).toString(),
    });
    if (!res.ok) {
      throw new DomainError(
        ErrorCodes.GOOGLE_NOT_CONNECTED,
        `token exchange failed: HTTP ${res.status}`,
      );
    }
    const data = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      scope: string;
    };
    if (!data.refresh_token) {
      throw new DomainError(
        ErrorCodes.GOOGLE_NOT_CONNECTED,
        "Google returned no refresh token (access_type=offline + prompt=consent required)",
      );
    }
    this.saveToken({
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: new Date(
        Date.now() + (data.expires_in ?? 3600) * 1000,
      ).toISOString(),
      scope: data.scope,
    });
  }

  status(): {
    configured: boolean;
    connected: boolean;
    expiresAt: string | null;
  } {
    const token = this.loadToken();
    return {
      configured: this.configured(),
      connected: token !== null,
      expiresAt: token?.expiresAt ?? null,
    };
  }

  /** A valid access token, refreshing first when expired or near expiry. */
  async getAccessToken(): Promise<string> {
    const token = this.loadToken();
    if (!token) {
      throw new DomainError(
        ErrorCodes.GOOGLE_NOT_CONNECTED,
        "Google is not connected — visit /google/auth/url and complete the flow",
      );
    }
    if (Date.parse(token.expiresAt) - Date.now() > 60_000)
      return token.accessToken;

    const res = await this.fetcher(this.endpoints.token, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.deps.clientId!,
        client_secret: this.deps.clientSecret!,
        refresh_token: token.refreshToken,
        grant_type: "refresh_token",
      }).toString(),
    });
    if (!res.ok) {
      throw new DomainError(
        ErrorCodes.GOOGLE_NOT_CONNECTED,
        `token refresh failed: HTTP ${res.status} — reconnect Google`,
      );
    }
    const data = (await res.json()) as {
      access_token: string;
      expires_in?: number;
    };
    const next: GoogleToken = {
      ...token,
      accessToken: data.access_token,
      expiresAt: new Date(
        Date.now() + (data.expires_in ?? 3600) * 1000,
      ).toISOString(),
    };
    this.saveToken(next);
    return next.accessToken;
  }

  disconnect(): void {
    fs.rmSync(this.tokenFile, { force: true });
  }

  private loadToken(): GoogleToken | null {
    if (!fs.existsSync(this.tokenFile)) return null;
    try {
      return GoogleTokenSchema.parse(
        JSON.parse(fs.readFileSync(this.tokenFile, "utf8")),
      );
    } catch {
      return null; // corrupt token file = treat as disconnected
    }
  }

  private saveToken(token: GoogleToken): void {
    const validated = GoogleTokenSchema.parse(token);
    fs.mkdirSync(path.dirname(this.tokenFile), { recursive: true });
    const tmp = `${this.tokenFile}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(validated, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.tokenFile);
  }
}
