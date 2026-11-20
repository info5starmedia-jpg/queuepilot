import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import {
  importProfilesCsv,
  importProfilesXlsx,
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

  it("keeps embedded newlines inside quotes and normalizes CRLF to LF (audit 5d)", () => {
    const rows = parseCsv('name,notes\r\nalice,"line1\r\nline2"\r\nbob,plain');
    expect(rows).toEqual([
      ["name", "notes"],
      ["alice", "line1\nline2"],
      ["bob", "plain"],
    ]);
    // No stray carriage returns survive inside the value.
    expect(rows[1]![1]).not.toContain("\r");
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

  it("rejects a non-IANA timezone (fails only that row)", () => {
    const { profiles, proxies } = services();
    const csv = `${HEADER}\ngood,,,,,windows,Europe/Madrid,es-ES\nbadtz,,,,,windows,not-a-tz\nutc-bare,,,,,windows,UTC`;
    const report = importProfilesCsv(profiles, proxies, csv);
    expect(report.succeeded).toBe(1);
    expect(report.errors).toHaveLength(2);
    expect(report.errors[0]!.message).toMatch(/not a valid IANA timezone/);
    expect(report.errors[1]!.message).toMatch(/not a valid IANA timezone/);
    expect(profiles.list()).toHaveLength(1);
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

/** Build a real .xlsx in memory (SheetJS), the way an operator's file would. */
function makeXlsx(rows: (string | number)[][]): Buffer {
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, "Profiles");
  return XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

describe("xlsx import (last Jancy parity row)", () => {
  it("runs the same pipeline as CSV: creates, reuses proxies, upserts by name", () => {
    const { profiles, proxies } = makeTestContext();
    const xlsx = makeXlsx([
      ["name", "proxy", "group", "timezone"],
      ["xl-alice", "1.2.3.4:8080:u:p", "g1", "America/Toronto"],
      ["xl-bob", "1.2.3.4:8080:u:p", "g2", ""],
    ]);
    const first = importProfilesXlsx(profiles, proxies, xlsx);
    expect(first.errors).toEqual([]);
    expect(first.succeeded).toBe(2);
    expect(proxies.list()).toHaveLength(1); // identical proxy reused
    expect(profiles.list()).toHaveLength(2);
    expect(profiles.list().find((p) => p.name === "xl-alice")?.group).toBe("g1");

    const again = importProfilesXlsx(profiles, proxies, xlsx);
    expect(again.results.every((r) => r.action === "updated")).toBe(true);
    expect(profiles.list()).toHaveLength(2);
  });

  it("dry-run writes nothing", () => {
    const { profiles, proxies } = makeTestContext();
    const report = importProfilesXlsx(
      profiles,
      proxies,
      makeXlsx([["name"], ["ghost"]]),
      { dryRun: true },
    );
    expect(report.succeeded).toBe(1);
    expect(report.results[0]!.action).toBe("would-create");
    expect(profiles.list()).toHaveLength(0);
  });

  it("a bad row fails only its own row", () => {
    const { profiles, proxies } = makeTestContext();
    const report = importProfilesXlsx(
      profiles,
      proxies,
      makeXlsx([
        ["name", "proxy"],
        ["ok", ""],
        ["broken", "not-a-proxy"],
      ]),
    );
    expect(report.succeeded).toBe(1);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]!.name).toBe("broken");
  });

  it("garbage bytes are a validation error, not a crash", () => {
    const { profiles, proxies } = makeTestContext();
    expect(() => importProfilesXlsx(profiles, proxies, Buffer.from("definitely not a zip"))).toThrow(
      expect.objectContaining({ code: "VALIDATION_FAILED" }),
    );
  });

  it("POST /profiles/import-xlsx imports over HTTP", async () => {
    const { app } = makeTestContext();
    const xlsx = makeXlsx([["name", "email"], ["http-xl", "xl@example.com"]]);
    const res = await app.inject({
      method: "POST",
      url: "/profiles/import-xlsx",
      payload: { xlsx: xlsx.toString("base64") },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().succeeded).toBe(1);
    const list = await app.inject({ method: "GET", url: "/profiles" });
    const found = list
      .json()
      .profiles.find((p: { name: string; email: string }) => p.name === "http-xl");
    expect(found.email).toBe("xl@example.com");
  });
});

describe("importProfilesCsv — email column (v0.14.7)", () => {
  function services() {
    const { profiles, proxies } = makeTestContext();
    return { profiles, proxies };
  }

  const EMAIL_HEADER = "name,email,proxy,group";

  it("creates a profile with the email set", () => {
    const { profiles, proxies } = services();
    const report = importProfilesCsv(
      profiles,
      proxies,
      `${EMAIL_HEADER}\nalice,alice@example.com,,g1`,
    );
    expect(report.succeeded).toBe(1);
    expect(profiles.list()[0]!.email).toBe("alice@example.com");
  });

  it("a bad email fails only that row", () => {
    const { profiles, proxies } = services();
    const report = importProfilesCsv(
      profiles,
      proxies,
      `${EMAIL_HEADER}\ngood,good@example.com,,\nbad,not-an-email,,`,
    );
    expect(report.succeeded).toBe(1);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]!.name).toBe("bad");
    expect(report.errors[0]!.message).toMatch(/not a valid email/);
    expect(profiles.list()).toHaveLength(1);
  });

  it("re-import updates the email; an empty cell leaves it unchanged", () => {
    const { profiles, proxies } = services();
    importProfilesCsv(profiles, proxies, `${EMAIL_HEADER}\nalice,old@example.com,`);
    const updated = importProfilesCsv(profiles, proxies, `${EMAIL_HEADER}\nalice,new@example.com,`);
    expect(updated.results[0]!.action).toBe("updated");
    expect(profiles.list()[0]!.email).toBe("new@example.com");
    // Empty email cell = "don't touch", never a silent clear.
    importProfilesCsv(profiles, proxies, `${EMAIL_HEADER}\nalice,,`);
    expect(profiles.list()[0]!.email).toBe("new@example.com");
  });
});

describe("importProfilesCsv — favorite + tab color (v0.14.10)", () => {
  function services() {
    const { profiles, proxies } = makeTestContext();
    return { profiles, proxies };
  }

  const FC_HEADER = "name,favorite,color";

  it("imports favorite and color into the persona bag", () => {
    const { profiles, proxies } = services();
    const report = importProfilesCsv(
      profiles,
      proxies,
      `${FC_HEADER}\nalice,1,#3af\nbob,yes,#a1B2c3`,
    );
    expect(report.succeeded).toBe(2);
    // list() orders by created_at DESC, so look rows up by name.
    const byName = new Map(profiles.list().map((p) => [p.name, p]));
    expect(byName.get("alice")!.extra.favorite).toBe(true);
    expect(byName.get("alice")!.extra.tabColor).toBe("#3af");
    expect(byName.get("bob")!.extra.favorite).toBe(true);
    expect(byName.get("bob")!.extra.tabColor).toBe("#a1B2c3");
  });

  it("an absent favorite column never unstars on re-import", () => {
    const { profiles, proxies } = services();
    importProfilesCsv(profiles, proxies, `${FC_HEADER}\nalice,1,#3af`);
    // Re-import without the favorite/color columns at all.
    importProfilesCsv(profiles, proxies, `name\nalice`);
    expect(profiles.list()[0]!.extra.favorite).toBe(true);
    expect(profiles.list()[0]!.extra.tabColor).toBe("#3af");
  });

  it("a bad color fails only that row, in dry-run too", () => {
    const { profiles, proxies } = services();
    const dry = importProfilesCsv(
      profiles,
      proxies,
      `${FC_HEADER}\ngood,1,#fff\nbad,1,notacolor`,
      { dryRun: true },
    );
    expect(dry.succeeded).toBe(1);
    expect(dry.errors[0]!.name).toBe("bad");
    expect(dry.errors[0]!.message).toMatch(/#rgb or #rrggbb/);
    expect(profiles.list()).toHaveLength(0);
  });
});
