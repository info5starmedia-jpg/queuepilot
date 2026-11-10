import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ErrorCodes,
  parseProfileCsv,
  parseProxyFile,
} from "@queuepilot/contracts";
import { makeTestContext } from "./helpers.js";

function writeTmp(name: string, content: string): string {
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "queuepilot-csv-")),
    name,
  );
  fs.writeFileSync(file, content);
  return file;
}

const HEADER =
  "Profile,Name,Email,Group,Tab Color,Address,City,State,Zip Code,DOB,Phone Number," +
  "SMS Number,SMS Number 2,SMS Number 3:44,Passcode,Passcode2,Free 1,Free 10," +
  "Proxy,Notes,URL,Time Zone,Favorite,CC Number:main,CC CVV:main,CC Exp Date:main";

const ROW1 =
  "acct-1,Alice,alice@example.com,VIP,#ff0000,1 Main St,Springfield,IL,62701,01/02/1990,5551234567," +
  "5551112222,5553334444,15554445555,presale123,vf456,favorite-color,shoe-size," +
  "10.0.0.1:8080:user:pass,line1\\nline2,https://example.com/start,America/Chicago,1,4111111111111111,123,12/29";

describe("parseProfileCsv (the column spec)", () => {
  it("parses the full optional-column spec by header name", () => {
    const { profiles, issues } = parseProfileCsv(`${HEADER}\n${ROW1}`);
    expect(issues).toEqual([]);
    expect(profiles).toHaveLength(1);
    const p = profiles[0]!;
    expect(p.key).toBe("acct-1");
    expect(p.group).toBe("VIP");
    expect(p.tabColor).toBe("#ff0000");
    expect(p.address).toMatchObject({
      line1: "1 Main St",
      city: "Springfield",
      state: "IL",
      zip: "62701",
    });
    expect(p.dob).toBe("01/02/1990");
    expect(p.phone).toBe("5551234567");
    expect(p.smsNumbers).toHaveLength(3);
    expect(p.smsNumbers[2]).toEqual({
      label: "SMS Number 3",
      number: "15554445555",
      countryCode: "44",
    });
    expect(p.passcodes).toEqual(["presale123", "vf456"]);
    expect(p.free).toEqual({
      "Free 1": "favorite-color",
      "Free 10": "shoe-size",
    });
    expect(p.proxies).toEqual(["10.0.0.1:8080:user:pass"]);
    expect(p.url).toBe("https://example.com/start");
    expect(p.timeZone).toBe("America/Chicago");
    expect(p.favorite).toBe(true);
    expect(p.creditCards[0]).toMatchObject({
      set: "main",
      number: "4111111111111111",
      cvv: "123",
      expDate: "12/29",
    });
  });

  it("fails the whole import when a required column is missing", () => {
    const { profiles, issues } = parseProfileCsv("Profile,Name\nacct-1,Alice");
    expect(profiles).toEqual([]);
    expect(issues[0]!.message).toContain("Email");
  });

  it("skips incomplete rows but keeps the good ones", () => {
    const text = `Profile,Name,Email\nacct-1,Alice,alice@example.com\nacct-2,,bob@example.com`;
    const { profiles, issues } = parseProfileCsv(text);
    expect(profiles).toHaveLength(1);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.line).toBe(3);
  });

  it("handles quoted fields with commas and newlines", () => {
    const text =
      'Profile,Name,Email,Notes\nacct-1,"Alice, A.",alice@example.com,"line one\nline two"';
    const { profiles, issues } = parseProfileCsv(text);
    expect(issues).toEqual([]);
    expect(profiles[0]!.name).toBe("Alice, A.");
    expect(profiles[0]!.notes).toBe("line one\nline two");
  });
});

describe("ProfileProviderService", () => {
  it("imports profiles with identities; missing group falls back to provider name", async () => {
    const { profileProviders, profiles } = makeTestContext();
    const file = writeTmp(
      "profiles.csv",
      "Profile,Name,Email\nacct-1,Alice,alice@example.com",
    );
    const { refresh } = await profileProviders.create({
      name: "Sheet A",
      sourcePath: file,
    });
    expect(refresh.imported).toBe(1);
    const p = profiles.list()[0]!;
    expect(p.email).toBe("alice@example.com");
    expect(p.group).toBe("Sheet A");
    expect(p.identityId).toBeTruthy();
    expect(p.providerKey).toBe("acct-1");
  });

  it("refresh upserts: data moves, identity and run state never churn", async () => {
    const { profileProviders, profiles, lifecycle } = makeTestContext();
    const file = writeTmp(
      "profiles.csv",
      "Profile,Name,Email,Notes\nacct-1,Alice,alice@example.com,v1",
    );
    const { provider } = await profileProviders.create({
      name: "Sheet A",
      sourcePath: file,
    });
    const before = profiles.list()[0]!;
    await lifecycle.start(before.id);

    // The CSV changes: new note, new row.
    fs.writeFileSync(
      file,
      "Profile,Name,Email,Notes\nacct-1,Alice,alice@example.com,v2\nacct-2,Bob,bob@example.com,new",
    );
    const result = await profileProviders.refresh(provider.id);
    expect(result).toMatchObject({ imported: 1, updated: 1 });

    const after = profiles.get(before.id);
    expect(after.notes).toBe("v2");
    expect(after.identityId).toBe(before.identityId); // never re-rolled by refresh
    expect(after.status).toBe("running"); // run state untouched
    await lifecycle.stop(before.id);
  });

  it("deleting a provider detaches profiles instead of deleting them", async () => {
    const { profileProviders, profiles } = makeTestContext();
    const file = writeTmp(
      "profiles.csv",
      "Profile,Name,Email\nacct-1,Alice,alice@example.com",
    );
    const { provider } = await profileProviders.create({
      name: "Sheet A",
      sourcePath: file,
    });
    profileProviders.delete(provider.id);
    const p = profiles.list()[0]!;
    expect(p.providerId).toBeNull();
    expect(p.providerKey).toBeNull();
  });

  it("refuses an unreadable source with PROVIDER_SOURCE_UNREADABLE", async () => {
    const { profileProviders } = makeTestContext();
    await expect(
      profileProviders.create({
        name: "ghost",
        sourcePath: "/nonexistent/nope.csv",
      }),
    ).rejects.toMatchObject({ code: ErrorCodes.PROVIDER_SOURCE_UNREADABLE });
  });
});

describe("parseProxyFile", () => {
  it("parses the 5-column format plus optional timezone", () => {
    const { proxies, issues } = parseProxyFile(
      "us-1,10.0.0.1,8080,user,pass,America/Chicago\nus-2,10.0.0.2,8080,,,",
      { delimiter: ",", hasHeader: false },
    );
    expect(issues).toEqual([]);
    expect(proxies[0]).toMatchObject({
      name: "us-1",
      port: 8080,
      username: "user",
      timezone: "America/Chicago",
    });
    expect(proxies[1]!.username).toBeNull();
  });

  it("honors delimiters and header rows; bad lines are reported, not fatal", () => {
    const { proxies, issues } = parseProxyFile(
      "name;host;port;user;pass\neu-1;10.0.0.9;3128;;\nbad;line",
      {
        delimiter: ";",
        hasHeader: true,
      },
    );
    expect(proxies).toHaveLength(1);
    expect(proxies[0]!.name).toBe("eu-1");
    expect(issues).toHaveLength(1);
  });
});

describe("ProxyProviderService", () => {
  const FILE =
    "us-1,10.0.0.1,8080,,,America/Chicago\nus-2,10.0.0.2,8080,,,\nus-3,10.0.0.3,8080,,,";

  it("imports proxies with timezone and tags them with the provider", async () => {
    const { proxyProviders, proxies } = makeTestContext();
    const file = writeTmp("proxies.txt", FILE);
    const { refresh } = await proxyProviders.create({
      name: "Pool",
      sourcePath: file,
    });
    expect(refresh.imported).toBe(3);
    const all = proxies.list();
    expect(all).toHaveLength(3);
    expect(all.find((p) => p.name === "us-1")!.timezone).toBe(
      "America/Chicago",
    );
  });

  it("start-over distribution walks the list and wraps", async () => {
    const { proxyProviders } = makeTestContext();
    const file = writeTmp("proxies.txt", FILE);
    const { provider } = await proxyProviders.create({
      name: "Pool",
      sourcePath: file,
      distribution: "start-over",
    });
    const seen = [1, 2, 3, 4].map(() => proxyProviders.next(provider.id).name);
    expect(seen).toEqual(["us-1", "us-2", "us-3", "us-1"]);
  });

  it("persist distribution returns the same proxy every time", async () => {
    const { proxyProviders } = makeTestContext();
    const file = writeTmp("proxies.txt", FILE);
    const { provider } = await proxyProviders.create({
      name: "Pool",
      sourcePath: file,
      distribution: "persist",
    });
    const seen = new Set(
      [1, 2, 3].map(() => proxyProviders.next(provider.id).name),
    );
    expect(seen.size).toBe(1);
  });

  it("refresh replaces the pool but refuses while a proxy is in use", async () => {
    const { proxyProviders, proxies, profiles } = makeTestContext();
    const file = writeTmp("proxies.txt", FILE);
    const { provider } = await proxyProviders.create({
      name: "Pool",
      sourcePath: file,
    });
    const inUse = proxies.list()[0]!;
    profiles.create({
      name: "attached",
      proxyId: inUse.id,
      generateFingerprint: false,
    });
    await expect(proxyProviders.refresh(provider.id)).rejects.toMatchObject({
      code: ErrorCodes.CONFLICT,
    });
  });
});

describe("provider HTTP routes", () => {
  it("creates, refreshes and deletes a profile provider over HTTP", async () => {
    const { app } = makeTestContext();
    const file = writeTmp(
      "profiles.csv",
      "Profile,Name,Email\nacct-1,Alice,alice@example.com",
    );
    const created = await app.inject({
      method: "POST",
      url: "/profile-providers",
      payload: { name: "Sheet A", sourcePath: file },
    });
    expect(created.statusCode).toBe(201);
    const providerId = created.json().provider.id;

    const refreshed = await app.inject({
      method: "POST",
      url: `/profile-providers/${providerId}/refresh`,
    });
    expect(refreshed.json().updated).toBe(1);

    const list = await app.inject({ method: "GET", url: "/profile-providers" });
    expect(list.json().providers).toHaveLength(1);

    const removed = await app.inject({
      method: "DELETE",
      url: `/profile-providers/${providerId}`,
    });
    expect(removed.statusCode).toBe(204);
  });

  it("hands out proxies via POST /proxy-providers/:id/next", async () => {
    const { app } = makeTestContext();
    const file = writeTmp(
      "proxies.txt",
      "us-1,10.0.0.1,8080,,,\nus-2,10.0.0.2,8080,,,",
    );
    const created = await app.inject({
      method: "POST",
      url: "/proxy-providers",
      payload: { name: "Pool", sourcePath: file, distribution: "start-over" },
    });
    expect(created.statusCode).toBe(201);
    const providerId = created.json().provider.id;
    const first = await app.inject({
      method: "POST",
      url: `/proxy-providers/${providerId}/next`,
    });
    const second = await app.inject({
      method: "POST",
      url: `/proxy-providers/${providerId}/next`,
    });
    expect(first.json().proxy.name).toBe("us-1");
    expect(second.json().proxy.name).toBe("us-2");
  });
});
