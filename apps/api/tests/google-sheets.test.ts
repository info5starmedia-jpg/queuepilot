import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ErrorCodes } from "@queuepilot/contracts";
import {
  GoogleAuthService,
  SHEETS_SCOPE,
  GMAIL_SCOPE,
} from "../src/application/google/google-auth.service.js";
import { SheetsClient } from "../src/application/google/sheets-client.js";
import { makeTestContext, MapSecretStore } from "./helpers.js";

function mockResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("GoogleAuthService", () => {
  const endpoints = {
    auth: "https://auth.example/auth",
    token: "https://auth.example/token",
  };

  function makeAuth(
    dir: string,
    overrides: Partial<ConstructorParameters<typeof GoogleAuthService>[0]> = {},
  ) {
    return new GoogleAuthService({
      secrets: new MapSecretStore(),
      dataDir: dir,
      clientId: "cid",
      clientSecret: "csecret",
      redirectUri: "http://127.0.0.1:50325/google/auth/callback",
      endpoints,
      ...overrides,
    });
  }

  it("start URL carries client id, loopback redirect, scope and PKCE", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qp-google-"));
    const auth = makeAuth(dir);
    const { url } = auth.start("sheets", [SHEETS_SCOPE]);
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe(endpoints.auth);
    expect(u.searchParams.get("client_id")).toBe("cid");
    expect(u.searchParams.get("redirect_uri")).toBe(
      "http://127.0.0.1:50325/google/auth/callback",
    );
    expect(u.searchParams.get("scope")).toContain("spreadsheets.readonly");
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("code_challenge")).toBeTruthy();
  });

  it("refuses without configured client credentials", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qp-google-"));
    const auth = makeAuth(dir, { clientId: null, clientSecret: null });
    expect(() => auth.start("sheets", [SHEETS_SCOPE])).toThrowError(
      expect.objectContaining({ code: ErrorCodes.GOOGLE_NOT_CONFIGURED }),
    );
    expect(auth.status()).toEqual({
      configured: false,
      connected: false,
      accounts: [],
      expiresAt: null,
    });
  });

  it("exchanges the callback code, persists per-account tokens, refreshes when expired", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qp-google-"));
    const calls: { url: string; body: string }[] = [];
    const fetcher = (async (url: string, init?: { body?: string }) => {
      calls.push({ body: String(init?.body ?? ""), url: String(url) });
      if (String(init?.body).includes("grant_type=authorization_code")) {
        return mockResponse({
          access_token: "access-1",
          refresh_token: "refresh-1",
          expires_in: 3600,
        });
      }
      return mockResponse({ access_token: "access-2", expires_in: 3600 });
    }) as unknown as typeof fetch;

    const auth = makeAuth(dir, { fetcher });
    const { state } = auth.start("sheets", [SHEETS_SCOPE]);
    await auth.complete(state, "the-code");
    expect(calls[0]!.url).toBe(endpoints.token);
    expect(calls[0]!.body).toContain("code=the-code");
    expect(calls[0]!.body).toContain("grant_type=authorization_code");
    expect(calls[0]!.body).toContain("code_verifier=");
    expect(auth.status().connected).toBe(true);
    expect(auth.accounts()).toEqual(["sheets"]);

    // Fresh token: no refresh call.
    expect(await auth.accessToken("sheets")).toBe("access-1");
    expect(await auth.getAccessToken()).toBe("access-1");
    expect(calls).toHaveLength(1);

    // Force expiry: rewrite the stored token with a past expiry.
    const secrets = (auth as unknown as { deps: { secrets: { get(k: string): string | null; set(k: string, v: string): void } } }).deps.secrets;
    const token = JSON.parse(secrets.get("google.oauth.sheets")!);
    token.expiresAt = new Date(Date.now() - 10_000).toISOString();
    secrets.set("google.oauth.sheets", JSON.stringify(token));

    expect(await auth.accessToken("sheets")).toBe("access-2");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body).toContain("grant_type=refresh_token");
    expect(calls[1]!.body).toContain("refresh_token=refresh-1");
  });

  it("multi-account: gmail and sheets tokens are isolated", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qp-google-"));
    const fetcher = (async (_url: string, init?: { body?: string }) => {
      const acct = String(init?.body).includes("code=gmail-code") ? "gmail" : "sheets";
      return mockResponse({
        access_token: `access-${acct}`,
        refresh_token: `refresh-${acct}`,
        expires_in: 3600,
      });
    }) as unknown as typeof fetch;
    const auth = makeAuth(dir, { fetcher });
    const s1 = auth.start("sheets", [SHEETS_SCOPE]);
    const s2 = auth.start("main@gmail.com", [GMAIL_SCOPE]);
    await auth.complete(s1.state, "sheets-code");
    await auth.complete(s2.state, "gmail-code");
    expect(await auth.accessToken("sheets")).toBe("access-sheets");
    expect(await auth.accessToken("main@gmail.com")).toBe("access-gmail");
    expect(auth.accounts()).toEqual(["main@gmail.com", "sheets"]);
    auth.disconnect("sheets");
    expect(auth.accounts()).toEqual(["main@gmail.com"]);
    await expect(auth.accessToken("sheets")).rejects.toMatchObject({
      code: ErrorCodes.GOOGLE_NOT_CONNECTED,
    });
  });

  it("accessToken before connecting is GOOGLE_NOT_CONNECTED", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qp-google-"));
    const auth = makeAuth(dir);
    await expect(auth.accessToken("sheets")).rejects.toMatchObject({
      code: ErrorCodes.GOOGLE_NOT_CONNECTED,
    });
  });
});

describe("Google Sheets providers", () => {
  it("imports profiles from a sheet through the same row pipeline as CSV", async () => {
    const { profileProviders, profiles, sheets } = makeTestContext();
    sheets.sheets.set("sheet-123", [
      ["Profile", "Name", "Email", "Group"],
      ["acct-1", "Alice", "alice@example.com", "drop-a"],
      ["acct-2", "Bob", "bob@example.com", ""],
      ["bad-row", "", ""], // missing Name/Email -> issue, skipped
    ]);

    const { provider, refresh } = await profileProviders.create({
      name: "My Sheet",
      sheetId: "sheet-123",
    });
    expect(provider.type).toBe("googleSheet");
    expect(provider.sourcePath).toBeNull();
    expect(refresh.imported).toBe(2);
    expect(refresh.issues).toHaveLength(1);

    const all = profiles.list();
    expect(all).toHaveLength(2);
    expect(all.find((p) => p.name === "Alice")!.group).toBe("drop-a");
    expect(all.find((p) => p.name === "Bob")!.group).toBe("My Sheet"); // provider-name fallback

    // Refresh upserts: edit the sheet, identity must not churn.
    const aliceId = all.find((p) => p.name === "Alice")!.identityId;
    sheets.sheets.set("sheet-123", [
      ["Profile", "Name", "Email", "Group"],
      ["acct-1", "Alice", "alice@example.com", "drop-b"],
    ]);
    const again = await profileProviders.refresh(provider.id);
    expect(again).toMatchObject({ imported: 0, updated: 1 });
    expect(profiles.list().find((p) => p.name === "Alice")!.identityId).toBe(
      aliceId,
    );
    expect(profiles.list().find((p) => p.name === "Alice")!.group).toBe(
      "drop-b",
    );
  });

  it("imports proxies from a sheet with a header row", async () => {
    const { proxyProviders, proxies, sheets } = makeTestContext();
    sheets.sheets.set("proxies-sheet", [
      ["name", "host", "port", "user", "pass", "tz"],
      ["us-1", "10.0.0.1", "8080", "", "", "America/Chicago"],
      ["us-2", "10.0.0.2", "8080", "u", "p", ""],
    ]);

    const { refresh } = await proxyProviders.create({
      name: "Sheet Pool",
      sheetId: "proxies-sheet",
      hasHeader: true,
    });
    expect(refresh.imported).toBe(2);
    const all = proxies.list();
    expect(all.find((p) => p.name === "us-1")!.timezone).toBe(
      "America/Chicago",
    );
    expect(all.find((p) => p.name === "us-2")!.username).toBe("u");
  });

  it("refuses sheet providers when Google is not connected", async () => {
    // A context whose services have NO SheetReader simulates disconnected Google.
    const { app } = makeTestContext();
    const res = await app.inject({
      method: "POST",
      url: "/profile-providers",
      payload: { name: "Ghost Sheet", sheetId: "missing-sheet" },
    });
    // FakeSheets has no rows for the id -> unreadable source, 422.
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("PROVIDER_SOURCE_UNREADABLE");
  });

  it("rejects a create with both sourcePath and sheetId", async () => {
    const { app } = makeTestContext();
    const res = await app.inject({
      method: "POST",
      url: "/profile-providers",
      payload: { name: "Both", sourcePath: "/tmp/x.csv", sheetId: "s1" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_FAILED");
  });
});

describe("SheetsClient", () => {
  it("reads values with a bearer token and reports HTTP failures by name", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qp-google-"));
    // Pre-seed a valid sheets token so no refresh happens.
    const secrets = new MapSecretStore();
    secrets.set(
      "google.oauth.sheets",
      JSON.stringify({
        accessToken: "tok-1",
        refreshToken: "r",
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        scope: "s",
      }),
    );
    const auth = new GoogleAuthService({
      secrets,
      dataDir: dir,
      clientId: "cid",
      clientSecret: "cs",
      redirectUri: "http://127.0.0.1:0/cb",
    });

    let seenAuth = "";
    const fetcher = (async (
      _url: string,
      init?: { headers?: { authorization: string } },
    ) => {
      seenAuth = init?.headers?.authorization ?? "";
      return mockResponse({
        values: [
          ["a", "b"],
          ["c", "d"],
        ],
      });
    }) as unknown as typeof fetch;
    const client = new SheetsClient(auth, "https://sheets.example", fetcher);

    const rows = await client.getValues("sheet-9", "A:ZZ");
    expect(rows).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
    expect(seenAuth).toBe("Bearer tok-1");

    const failing = new SheetsClient(
      auth,
      "https://sheets.example",
      (async () => mockResponse({}, 403)) as unknown as typeof fetch,
    );
    await expect(failing.getValues("sheet-9", "A:ZZ")).rejects.toMatchObject({
      code: ErrorCodes.PROVIDER_SOURCE_UNREADABLE,
    });
  });
});
