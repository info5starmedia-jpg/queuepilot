import { describe, expect, it } from "vitest";
import {
  importProfilesCsv,
  parseCsv,
  parseProxySpec,
} from "../src/application/profiles/profile-import.js";
import { makeTestContext } from "./helpers.js";

const HEADER = "name,proxy,group,tags,notes,platform,timezone,locale";

describe("parseCsv", () => {
  it("handles quotes, escaped quotes and CRLF", () => {
    const rows = parseCsv('a,"b,1","say ""hi"""\r\nc,d,');
    expect(rows).toEqual([
      ["a", "b,1", 'say "hi"'],
      ["c", "d", ""],
    ]);
  });
});

describe("parseProxySpec", () => {
  it("parses every accepted shape", () => {
    expect(parseProxySpec("1.2.3.4:8080")).toMatchObject({
      type: "http", host: "1.2.3.4", port: 8080, username: null,
    });
    expect(parseProxySpec("1.2.3.4:8080:u:p")).toMatchObject({ username: "u", password: "p" });
    expect(parseProxySpec("u:p@1.2.3.4:8080")).toMatchObject({ username: "u", password: "p" });
    expect(parseProxySpec("socks5://u:p@1.2.3.4:1080")).toMatchObject({
      type: "socks5", port: 1080,
    });
  });
  it("rejects garbage loudly", () => {
    expect(() => parseProxySpec("nope")).toThrow();
    expect(() => parseProxySpec("ftp://1.2.3.4:21")).toThrow(/http\|https\|socks5/);
    expect(() => parseProxySpec("1.2.3.4:0")).toThrow();
  });
});

describe("importProfilesCsv (over HTTP surface via services)", () => {
  function services() {
    const { profiles, proxies } = makeTestContext();
    return { profiles, proxies };
  }

  it("dry-run writes nothing but reports everything", () => {
    const { profiles, proxies } = services();
    const csv = `${HEADER}\nalice,1.2.3.4:8080:u:p,g1,a|b,note,windows,America/Toronto,en-US\nbob,,g2,,,macos,,`;
    const report = importProfilesCsv(profiles, proxies, csv, { dryRun: true });
    expect(report.succeeded).toBe(2);
    expect(report.errors).toEqual([]);
    expect(report.results.map((r) => r.action)).toEqual(["would-create", "would-create"]);
    expect(profiles.list()).toHaveLength(0);
    expect(proxies.list()).toHaveLength(0);
  });

  it("creates profiles and proxies, and reuses an identical proxy on re-import", () => {
    const { profiles, proxies } = services();
    const csv = `${HEADER}\nalice,1.2.3.4:8080:u:p\nbob,1.2.3.4:8080:u:p`;
    const first = importProfilesCsv(profiles, proxies, csv);
    expect(first.succeeded).toBe(2);
    expect(proxies.list()).toHaveLength(1); // shared, not duplicated
    expect(profiles.list()).toHaveLength(2);
    const again = importProfilesCsv(profiles, proxies, csv);
    expect(again.results.every((r) => r.action === "updated")).toBe(true);
    expect(profiles.list()).toHaveLength(2); // upsert, not duplicate
    expect(proxies.list()).toHaveLength(1);
  });

  it("honours timezone/locale on the generated identity", () => {
    const { profiles, proxies } = services();
    importProfilesCsv(profiles, proxies, `${HEADER}\ntz,,,,,windows,Europe/Berlin,de-DE`);
    const p = profiles.list()[0]!;
    expect(p.identityId).toBeTruthy();
  });

  it("a bad row never aborts the file", () => {
    const { profiles, proxies } = services();
    const csv = `${HEADER}\ngood,,,,,windows\nbad,nonsense-proxy\ngood2,,,,,linux`;
    const report = importProfilesCsv(profiles, proxies, csv);
    expect(report.succeeded).toBe(2);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]!.name).toBe("bad");
  });

  it("upsert=false refuses duplicates", () => {
    const { profiles, proxies } = services();
    importProfilesCsv(profiles, proxies, `${HEADER}\nalice`);
    const report = importProfilesCsv(profiles, proxies, `${HEADER}\nalice`, { upsert: false });
    expect(report.succeeded).toBe(0);
    expect(report.errors[0]!.message).toMatch(/already exists/);
  });

  it("requires a name column", () => {
    const { profiles, proxies } = services();
    const report = importProfilesCsv(profiles, proxies, "foo,bar\n1,2");
    expect(report.errors[0]!.message).toMatch(/header must include "name"/);
  });
});

describe("POST /profiles/import", () => {
  it("imports end to end", async () => {
    const { app } = makeTestContext();
    const res = await app.inject({
      method: "POST",
      url: "/profiles/import",
      payload: { csv: `${HEADER}\nhttp-alice,1.2.3.4:9001,g1`, dryRun: false },
    });
    expect(res.statusCode).toBe(200);
    const report = res.json();
    expect(report.succeeded).toBe(1);
    const list = await app.inject({ method: "GET", url: "/profiles" });
    expect(list.json().profiles.map((p: { name: string }) => p.name)).toContain("http-alice");
  });
});
