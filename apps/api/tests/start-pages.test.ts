import { describe, expect, it } from "vitest";
import { ErrorCodes } from "@queuepilot/contracts";
import { startUrlsOf } from "../src/application/profiles/start-pages.js";
import { importProfilesCsv } from "../src/application/profiles/profile-import.js";
import { makeTestContext } from "./helpers.js";

/**
 * Jancy URL column (v0.14.12): `url` in CSV import → `extra.startUrls` →
 * opened automatically right after the profile launches.
 */

describe("startUrlsOf", () => {
  it("returns [] for null, empty bags, and malformed values", () => {
    expect(startUrlsOf(null)).toEqual([]);
    expect(startUrlsOf({})).toEqual([]);
    expect(startUrlsOf({ startUrls: "not-an-array" })).toEqual([]);
    expect(startUrlsOf({ startUrls: ["not-a-url"] })).toEqual([]);
    expect(startUrlsOf({ startUrls: Array(26).fill("https://x.example") })).toEqual([]);
  });

  it("reads a valid list verbatim", () => {
    expect(
      startUrlsOf({ startUrls: ["https://a.example", "https://b.example/path"] }),
    ).toEqual(["https://a.example", "https://b.example/path"]);
  });
});

describe("start pages at launch", () => {
  it("launch opens every configured start page as a tab", async () => {
    const { lifecycle, profiles } = makeTestContext();
    const p = profiles.create({ name: "starter", generateFingerprint: true });
    profiles.updatePersona(p.id, {
      startUrls: ["https://mail.example.com", "https://news.example.com"],
    });

    await lifecycle.start(p.id);
    const urls = lifecycle
      .listTabs(p.id)
      .tabs.map((t) => t.url)
      .sort();
    expect(urls).toEqual(["https://mail.example.com", "https://news.example.com"]);

    await lifecycle.stop(p.id);
  });

  it("a profile without start pages launches with no extra tabs", async () => {
    const { lifecycle, profiles } = makeTestContext();
    const p = profiles.create({ name: "plain", generateFingerprint: true });
    await lifecycle.start(p.id);
    expect(lifecycle.listTabs(p.id).tabs).toHaveLength(0);
    await lifecycle.stop(p.id);
  });
});

describe("CSV url column", () => {
  it("imports | separated start pages; a bad URL fails only that row", () => {
    const { profiles, proxies } = makeTestContext();
    const report = importProfilesCsv(
      profiles,
      proxies,
      "name,url\nalice,https://a.example | https://b.example\nbob,not-a-url",
    );
    expect(report.succeeded).toBe(1);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toMatchObject({ row: 3, name: "bob" });
    expect(report.errors[0]!.message).toContain("not a valid URL");
    const byName = new Map(profiles.list().map((p) => [p.name, p]));
    expect(byName.get("alice")!.extra.startUrls).toEqual([
      "https://a.example",
      "https://b.example",
    ]);
    expect(byName.has("bob")).toBe(false);
  });

  it("an absent url column never clears the stored list on re-import", () => {
    const { profiles, proxies } = makeTestContext();
    importProfilesCsv(profiles, proxies, "name,url\nalice,https://a.example");
    importProfilesCsv(profiles, proxies, "name\nalice");
    expect(profiles.list()[0]!.extra.startUrls).toEqual(["https://a.example"]);
  });

  it("PATCH persona startUrls validates URLs (bad list → 400)", async () => {
    const { app, profiles } = makeTestContext();
    const p = profiles.create({ name: "patch-me", generateFingerprint: true });
    const res = await app.inject({
      method: "PATCH",
      url: `/profiles/${p.id}/persona`,
      payload: { startUrls: ["definitely-not-a-url"] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe(ErrorCodes.VALIDATION_FAILED);
  });
});
