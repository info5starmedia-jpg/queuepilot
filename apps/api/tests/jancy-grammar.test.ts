import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { parseProfileCsv } from "@queuepilot/contracts";
import {
  ResolverRegistry,
  registerBuiltinResolvers,
  matchSiteColumn,
  parseSiteSpec,
  resolveSiteFieldForUrl,
  type ResolverContext,
} from "../src/application/resolvers/resolver-registry.js";
import { makeTestContext, TEST_IMPORTS_DIR } from "./helpers.js";

/**
 * J1 slice A — Jancy's profile-CSV and Site-column grammar, exactly as
 * docs.jancy.io/docs/optional-columns and /docs/resolver-columns describe it.
 */

function reg(): ResolverRegistry {
  const r = new ResolverRegistry();
  registerBuiltinResolvers(r);
  return r;
}

describe("Jancy resolver grammar", () => {
  it("$literal is a static value, taken verbatim (no alias expansion)", async () => {
    const aliases = { get: () => "SHOULD-NOT-APPEAR" } as never;
    expect(await reg().resolve("$Jancyiscool!", {}, aliases)).toBe("Jancyiscool!");
    expect(await reg().resolve("$a:b@c,d", {})).toBe("a:b@c,d");
  });

  it("hands resolvers Jancy's positional resolverArgs", async () => {
    const r = reg();
    let seen: ResolverContext | null = null;
    r.register("probe", async (_args, ctx) => {
      seen = ctx;
      return "ok";
    });
    await r.resolve("probe:one:two:three", {});
    expect(seen!.resolverArgs).toEqual(["one", "two", "three"]);
    await r.resolve("probe", {});
    expect(seen!.resolverArgs).toEqual([]);
  });

  it("splits a Site cell on ', field=' only — commas inside values survive", () => {
    expect(
      parseSiteSpec("password=$pa,ss, emailcode=gmail:me:ticketmaster, othercode=$x"),
    ).toEqual({
      password: "$pa,ss",
      emailcode: "gmail:me:ticketmaster",
      othercode: "$x",
    });
  });
});

describe("Jancy Site-column matching", () => {
  const sites = {
    "*": "password=$wild",
    Ticketmaster: "password=$tm",
    AXS: "password=$axs",
    "somesite.com; other.org": "password=$custom",
    MLB: "password=$mlb",
  };

  it("brand columns match every documented domain, any subdomain or suffix", () => {
    for (const url of [
      "https://www.ticketmaster.com/event/1",
      "https://am.ticketmaster.com/x",
      "https://www.ticketmaster.co.uk/",
      "https://www.ticketmaster.com.mx/evento",
      "https://www.livenation.com/",
    ]) {
      expect(matchSiteColumn(sites, url)).toMatchObject({ column: "Ticketmaster", siteKind: "ticketmaster" });
    }
    expect(matchSiteColumn(sites, "https://www.axs.com/e")).toMatchObject({ column: "AXS", siteKind: "axs" });
    expect(matchSiteColumn(sites, "https://www.mlb.com/tickets")).toMatchObject({ column: "MLB", siteKind: "other" });
  });

  it("brands win even when a * column comes earlier in the file", () => {
    expect(matchSiteColumn(sites, "https://www.ticketmaster.com/")?.column).toBe("Ticketmaster");
  });

  it("custom columns are evaluated in file order — a leading * shadows later ones", () => {
    expect(matchSiteColumn(sites, "https://shop.other.org/x")?.column).toBe("*");
    const ordered = { "somesite.com; other.org": "password=$custom", "*": "password=$wild" };
    expect(matchSiteColumn(ordered, "https://shop.other.org/x")?.column).toBe("somesite.com; other.org");
    expect(matchSiteColumn(ordered, "https://www.somesite.com/a")?.column).toBe("somesite.com; other.org");
    expect(matchSiteColumn(ordered, "https://elsewhere.net/")?.column).toBe("*");
  });

  it("a custom pattern is literal (dots are not wildcards)", () => {
    expect(matchSiteColumn({ "a.com": "password=$x" }, "https://abcom.net/")).toBeNull();
  });

  it("look-alike hosts and query strings never get a brand's or a site's password", () => {
    for (const url of [
      "https://ticketmaster.com.evil.net/login",
      "https://notticketmaster.com/",
      "https://evil.net/?next=ticketmaster.com",
      "https://evil.net/ticketmaster.com/login",
    ]) {
      expect(matchSiteColumn({ Ticketmaster: "password=$tm" }, url)).toBeNull();
    }
    expect(matchSiteColumn({ "somesite.com": "password=$s" }, "https://evil.net/?somesite.com")).toBeNull();
    expect(matchSiteColumn({ "somesite.com": "password=$s" }, "https://somesite.com.evil.io/")).toBeNull();
  });

  it("a pattern containing / keeps Jancy's whole-URL match (path targeting)", () => {
    const s = { "example.com/presale": "password=$p" };
    expect(matchSiteColumn(s, "https://www.example.com/presale/123")?.column).toBe("example.com/presale");
    expect(matchSiteColumn(s, "https://www.example.com/other")).toBeNull();
  });

  it("no match and no * column → null", () => {
    expect(matchSiteColumn({ AXS: "password=$a" }, "https://example.com/")).toBeNull();
    expect(matchSiteColumn(undefined, "https://example.com/")).toBeNull();
  });

  it("resolves through the matched column with Jancy's site kind and url", async () => {
    const r = reg();
    let seen: ResolverContext | null = null;
    r.register("probe", async (_a, ctx) => {
      seen = ctx;
      return "v";
    });
    const out = await resolveSiteFieldForUrl(
      { Ticketmaster: "emailcode=probe:acct:ticketmaster", "*": "password=$w" },
      "https://auth.ticketmaster.com/login",
      "emailcode",
      { profileId: "p1" },
      r,
    );
    expect(out).toMatchObject({ found: true, value: "v", column: "Ticketmaster" });
    expect(seen).toMatchObject({
      siteKind: "ticketmaster",
      site: "ticketmaster",
      url: "https://auth.ticketmaster.com/login",
      field: "emailcode",
      resolverArgs: ["acct", "ticketmaster"],
    });
    const miss = await resolveSiteFieldForUrl(
      { Ticketmaster: "password=$tm" },
      "https://www.ticketmaster.com/",
      "smscode",
      {},
      r,
    );
    expect(miss).toMatchObject({ found: false, column: "Ticketmaster" });
  });
});

describe("Jancy profile CSV columns", () => {
  const header =
    "Profile,Name,Email,Phone Number,SMS Number,SMS Number backup,Passcode VF,Passcode presale," +
    "Proxy,Proxy backup,Proxy Resolver,Persist Cookies,Persist Sessions,Buyer," +
    "Site:Ticketmaster,Site: AXS,Site:somesite.com; other.org,Site:*";
  const row =
    'a1,Al Bo,al@example.com,1-555-123-4567,15551112222,447700900123,VF1,PRE1,' +
    '1.2.3.4:80,5.6.7.8:81:u:p,ticketsuite:@ts,1,0,"buyer1, buyer2",' +
    '"password=$tm, emailcode=gmail:me",password=$axs,password=$c,password=$w';

  it("parses Site columns in file order and the Persist/Buyer/Proxy Resolver columns", () => {
    const { profiles, issues } = parseProfileCsv(`${header}\n${row}`);
    expect(issues).toEqual([]);
    const p = profiles[0]!;
    expect(Object.keys(p.sites)).toEqual(["Ticketmaster", "AXS", "somesite.com; other.org", "*"]);
    expect(p.sites.Ticketmaster).toBe("password=$tm, emailcode=gmail:me");
    expect(p.persistCookies).toBe(true);
    expect(p.persistSessions).toBe(false);
    expect(p.buyers).toEqual(["buyer1", "buyer2"]);
    expect(p.proxyResolver).toBe("ticketsuite:@ts");
  });

  it("accepts any text after Passcode / SMS Number / Proxy, left to right", () => {
    const p = parseProfileCsv(`${header}\n${row}`).profiles[0]!;
    expect(p.passcodes).toEqual(["VF1", "PRE1"]);
    expect(p.proxies).toEqual(["1.2.3.4:80", "5.6.7.8:81:u:p"]);
    expect(p.smsNumbers).toEqual([
      { label: "SMS Number", number: "5551112222", countryCode: "1" },
      { label: "SMS Number backup", number: "7700900123", countryCode: "44" },
    ]);
  });

  it("strips a leading US country code from Phone Number", () => {
    expect(parseProfileCsv(`${header}\n${row}`).profiles[0]!.phone).toBe("5551234567");
  });

  it("Persist values other than 0/1 follow the global setting (null)", () => {
    const csv = "Profile,Name,Email,Persist Cookies,Persist Sessions\na,B C,b@x.com,yes,";
    const p = parseProfileCsv(csv).profiles[0]!;
    expect(p.persistCookies).toBeNull();
    expect(p.persistSessions).toBeNull();
  });

  it("reports unknown (case-mismatched) headers instead of silently dropping them", () => {
    const { profiles, issues } = parseProfileCsv(
      "Profile,Name,Email,site:Ticketmaster,group\na,B C,b@x.com,password=$x,G",
    );
    expect(profiles).toHaveLength(1);
    expect(issues.map((i) => i.message)).toEqual([
      'unknown column "site:Ticketmaster" ignored (headers are case-sensitive)',
      'unknown column "group" ignored (headers are case-sensitive)',
    ]);
  });
});

describe("provider import keeps Jancy columns on the profile", () => {
  it("stores sites/persist/buyers/proxyResolver in extra, and resolves by URL over HTTP", async () => {
    const ctx = makeTestContext(undefined, { apiToken: "grammar-test-token" }); // SEC-1
    const headers = { authorization: "Bearer grammar-test-token" };
    fs.mkdirSync(TEST_IMPORTS_DIR, { recursive: true });
    const file = path.join(fs.mkdtempSync(path.join(TEST_IMPORTS_DIR, "jancy-")), "p.csv");
    fs.writeFileSync(
      file,
      "Profile,Name,Email,Buyer,Site:Ticketmaster,Site:*\n" +
        'a1,Al Bo,al@example.com,b1,"password=$tm-pass, othercode=$x",password=$any\n',
    );
    await ctx.profileProviders.create({ name: "J", sourcePath: file });
    const p = ctx.profiles.list()[0]!;
    expect(p.extra).toMatchObject({
      sites: { Ticketmaster: "password=$tm-pass, othercode=$x", "*": "password=$any" },
      buyers: ["b1"],
    });
    expect(p.extra).not.toHaveProperty("persistCookies");

    const { app } = ctx;
    const res = await app.inject({
      method: "POST",
      url: `/profiles/${p.id}/resolve`,
      headers,
      payload: { url: "https://www.ticketmaster.com/event/1", field: "password" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ found: true, value: "tm-pass", column: "Ticketmaster" });
    const other = await app.inject({
      method: "POST",
      url: `/profiles/${p.id}/resolve`,
      headers,
      payload: { url: "https://example.org/", field: "password" },
    });
    expect(other.json()).toMatchObject({ found: true, value: "any", column: "*" });
    await app.close();
  });
});
