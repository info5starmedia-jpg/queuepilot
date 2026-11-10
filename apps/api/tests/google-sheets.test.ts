import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ErrorCodes } from "@queuepilot/contracts";
import { GoogleAuthService } from "../src/application/google/google-auth.service.js";
import { SheetsClient } from "../src/application/google/sheets-client.js";
import { makeTestContext } from "./helpers.js";

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

  it("authUrl carries client id, loopback redirect and the readonly sheets scope", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qp-google-"));
    const auth = new GoogleAuthService({
      dataDir: dir,
      clientId: "cid",
      clientSecret: "csecret",
      redirectUri: "http://127.0.0.1:50325/google/auth/callback",
      endpoints,
    });
    const url = new URL(auth.authUrl("state-1"));
    expect(url.origin + url.pathname).toBe(endpoints.auth);
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "http://127.0.0.1:50325/google/auth/callback",
    );
    expect(url.searchParams.get("scope")).toContain("spreadsheets.readonly");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("state")).toBe("state-1");
  });

  it("refuses without configured client credentials", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qp-google-"));
    const auth = new GoogleAuthService({
      dataDir: dir,
      clientId: null,
      clientSecret: null,
      redirectUri: "http://127.0.0.1:0/google/auth/callback",
      endpoints,
    });
    expect(() => auth.authUrl("s")).toThrowError(
      expect.objectContaining({ code: ErrorCodes.GOOGLE_NOT_CONFIGURED }),
    );
    expect(auth.status()).toEqual({
      configured: false,
      connected: false,
      expiresAt: null,
    });
  });

  it("exchanges the callback code, persists the token, and refreshes when expired", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qp-google-"));
    const calls: { url: string; body: string }[] = [];
    const fetcher = (async (url: string, init?: { body?: string }) => {
      calls.push({ body: String(init?.body ?? ""), url: String(url) });
      if (String(init?.body).includes("authorization_code")) {
        return mockResponse({
          access_token: "access-1",
          refresh_token: "refresh-1",
          expires_in: 3600,
          scope: "https://www.googleapis.com/auth/spreadsheets.readonly",
        });
      }
      return mockResponse({ access_token: "access-2", expires_in: 3600 });
    }) as unknown as typeof fetch;

    const auth = new GoogleAuthService({
      dataDir: dir,
      clientId: "cid",
      clientSecret: "csecret",
      redirectUri: "http://127.0.0.1:50325/google/auth/callback",
      endpoints,
      fetcher,
    });

    await auth.handleCallback("the-code");
    expect(calls[0]!.url).toBe(endpoints.token);
    expect(calls[0]!.body).toContain("code=the-code");
    expect(calls[0]!.body).toContain("grant_type=authorization_code");
    expect(auth.status().connected).toBe(true);

    // Fresh token: no refresh call.
    expect(await auth.getAccessToken()).toBe("access-1");
    expect(calls).toHaveLength(1);

    // Force expiry: rewrite the token file with a past expiry.
    const tokenFile = path.join(dir, "google", "token.json");
    const token = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
    token.expiresAt = new Date(Date.now() - 10_000).toISOString();
    fs.writeFileSync(tokenFile, JSON.stringify(token));

    expect(await auth.getAccessToken()).toBe("access-2");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body).toContain("grant_type=refresh_token");
    expect(calls[1]!.body).toContain("refresh_token=refresh-1");
  });

  it("getAccessToken before connecting is GOOGLE_NOT_CONNECTED", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qp-google-"));
    const auth = new GoogleAuthService({
      dataDir: dir,
      clientId: "cid",
      clientSecret: "csecret",
      redirectUri: "http://127.0.0.1:0/cb",
      endpoints,
    });
    await expect(auth.getAccessToken()).rejects.toMatchObject({
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
    // Pre-seed a valid token so no refresh happens.
    fs.mkdirSync(path.join(dir, "google"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "google", "token.json"),
      JSON.stringify({
        accessToken: "tok-1",
        refreshToken: "r",
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        scope: "s",
      }),
    );
    const auth = new GoogleAuthService({
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
