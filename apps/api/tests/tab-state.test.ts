import { describe, expect, it } from "vitest";
import { makeTestContext } from "./helpers.js";
import { deckLabel } from "../src/application/tabs/tab-state.service.js";

/** J3a — tab state per profile (Jancy Tab object) + the cross-run Tab View. */
describe("tab state", () => {
  it("patches state, merges data keys, and survives a run", async () => {
    const ctx = makeTestContext();
    const p = ctx.profiles.create({ name: "tm-1", generateFingerprint: true });
    const get = async () => (await ctx.app.inject({ method: "GET", url: `/profiles/${p.id}/tab-state` })).json();
    expect(await get()).toMatchObject({ passcodes: [], notes: "", data: {}, priority: null });

    const r = await ctx.app.inject({
      method: "PATCH",
      url: `/profiles/${p.id}/tab-state`,
      payload: { notes: "sec 112", data: { queuePosition: 1520, eventName: "Tour" }, priority: 5, colour: "#33aaff" },
    });
    expect(r.statusCode).toBe(200);
    await ctx.app.inject({ method: "PATCH", url: `/profiles/${p.id}/tab-state`, payload: { data: { eventName: null, cartTimer: "9:58" } } });
    expect((await get()).data).toEqual({ queuePosition: 1520, cartTimer: "9:58" });

    await ctx.lifecycle.start(p.id);
    await ctx.lifecycle.stop(p.id);
    expect(await get()).toMatchObject({ notes: "sec 112", priority: 5, colour: "#33aaff" });
  });

  it("refuses bad input and unknown profiles", async () => {
    const ctx = makeTestContext();
    const p = ctx.profiles.create({ name: "tm-2", generateFingerprint: true });
    for (const payload of [{ colour: "red" }, { priority: 1.5 }, { timezone: "../etc" }, { bogus: 1 }, { notes: "x".repeat(4001) }]) {
      expect((await ctx.app.inject({ method: "PATCH", url: `/profiles/${p.id}/tab-state`, payload })).statusCode, JSON.stringify(payload)).toBe(400);
    }
    const ghost = await ctx.app.inject({ method: "GET", url: "/profiles/00000000-0000-4000-8000-000000000000/tab-state" });
    expect(ghost.statusCode).toBe(404);
  });

  it("bulk sets passcodes (comma = many) and notes with repeat; passcodes are taken in order", async () => {
    const ctx = makeTestContext();
    const ids = ["a", "b", "c"].map((n) => ctx.profiles.create({ name: n, generateFingerprint: true }).id);
    const bulk = await ctx.app.inject({
      method: "POST",
      url: "/tab-state/bulk",
      payload: { profileIds: ids, field: "passcodes", lines: ["P1, P2", "P3"], repeat: true },
    });
    expect(bulk.json()).toEqual({ updated: 3 });
    const take = async (id: string) => (await ctx.app.inject({ method: "POST", url: `/profiles/${id}/tab-state/passcode` })).json().passcode;
    expect(await take(ids[0]!)).toBe("P1");
    expect(await take(ids[0]!)).toBe("P2");
    expect(await take(ids[0]!)).toBeNull();
    expect(await take(ids[2]!)).toBe("P1"); // repeat cycled line 1

    const notes = await ctx.app.inject({ method: "POST", url: "/tab-state/bulk", payload: { profileIds: ids, field: "notes", lines: ["only first"] } });
    expect(notes.json()).toEqual({ updated: 1 });
  });

  it("Tab View lists running profiles with open tabs and the email · position label", async () => {
    const ctx = makeTestContext();
    const p = ctx.profiles.create({ name: "deck-1", generateFingerprint: true });
    ctx.profiles.update(p.id, { email: "fan@example.com" });
    const idle = ctx.profiles.create({ name: "idle", generateFingerprint: true });
    await ctx.app.inject({ method: "PATCH", url: `/profiles/${p.id}/tab-state`, payload: { data: { queuePosition: 42 } } });
    await ctx.lifecycle.start(p.id);
    const view = (await ctx.app.inject({ method: "GET", url: "/tab-view" })).json().tabs as { profileId: string; label: string }[];
    expect(view.map((v) => v.profileId)).toEqual([p.id]);
    expect(view[0]!.label).toBe("fan@example.com · #42");
    const all = (await ctx.app.inject({ method: "GET", url: "/tab-view?all=1" })).json().tabs as { profileId: string }[];
    expect(all.map((v) => v.profileId)).toEqual(expect.arrayContaining([p.id, idle.id]));
    await ctx.lifecycle.stop(p.id);
  });

  it("exports CSV with formula-injection guard; clear-codes empties codes", async () => {
    const ctx = makeTestContext();
    const p = ctx.profiles.create({ name: "=HYPERLINK(1)", generateFingerprint: true });
    await ctx.app.inject({ method: "PATCH", url: `/profiles/${p.id}/tab-state`, payload: { notes: "a,b", data: { queuePosition: 7 } } });
    const csv = await ctx.app.inject({ method: "POST", url: "/tab-state/export", payload: { profileIds: [p.id] } });
    expect(csv.headers["content-type"]).toContain("text/csv");
    const row = csv.body.split("\r\n")[1]!;
    expect(row.startsWith("'=HYPERLINK(1)")).toBe(true);
    expect(row).toContain('"a,b"');
    expect(row).toContain(",7,");

    ctx.tabState.recordCode(p.id, "emailCode", { value: "123456", timestamp: null, isError: false });
    expect(ctx.tabState.get(p.id).codes.emailCode?.value).toBe("123456");
    await ctx.app.inject({ method: "POST", url: `/profiles/${p.id}/tab-state/clear-codes` });
    expect(ctx.tabState.get(p.id).codes.emailCode).toBeNull();
  });

  it("deckLabel falls back to the profile name and omits an empty position", () => {
    const empty = { passcodes: [], notes: "", data: {}, priority: null, priorityGroup: null, colour: null, subtitle: null, timezone: null, codes: { emailCode: null, smsCode: null, otherCode: null } };
    expect(deckLabel({ name: "n", email: null }, empty)).toBe("n");
    expect(deckLabel({ name: "n", email: "e@x.com" }, { ...empty, data: { queuePosition: "" } })).toBe("e@x.com");
  });

  it("tab state goes with the profile on delete", async () => {
    const ctx = makeTestContext();
    const p = ctx.profiles.create({ name: "gone", generateFingerprint: true });
    await ctx.app.inject({ method: "PATCH", url: `/profiles/${p.id}/tab-state`, payload: { notes: "x" } });
    ctx.profiles.delete(p.id);
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM tab_state WHERE profile_id = ?").get(p.id)).toEqual({ n: 0 });
  });
});

describe("tab state routes are browser-origin denied", () => {
  it("refuses requests from a page inside a profile browser", async () => {
    const ctx = makeTestContext();
    const p = ctx.profiles.create({ name: "o", generateFingerprint: true });
    for (const [method, url] of [["GET", `/profiles/${p.id}/tab-state`], ["POST", `/profiles/${p.id}/tab-state/passcode`], ["GET", "/tab-view"], ["POST", "/tab-state/export"]] as const) {
      const r = await ctx.app.inject({ method, url, headers: { "sec-fetch-site": "cross-site" } });
      expect(r.statusCode, url).toBe(403);
    }
  });
});

describe("origin deny matches encoded paths (audit MEDIUM)", () => {
  it("refuses percent-encoded, double-slash and ;param variants", async () => {
    const ctx = makeTestContext();
    const p = ctx.profiles.create({ name: "enc", generateFingerprint: true });
    for (const url of [
      "/%74ab-view",
      `/profiles/${p.id}/tab%2Dstate/clear-codes`,
      `/profiles/${p.id}/tab-state;x/passcode`,
      "//tab-view",
      "/%6Ayl",
      "/%E0%A4%A",
    ]) {
      const r = await ctx.app.inject({ method: "POST", url, headers: { "sec-fetch-site": "cross-site" } });
      // 403 from the deny hook, or 400 when Fastify refuses an undecodable URL first.
      expect([400, 403], url).toContain(r.statusCode);
    }
  });

  it("rejects reserved and oversized data keys", async () => {
    const ctx = makeTestContext();
    const p = ctx.profiles.create({ name: "keys", generateFingerprint: true });
    for (const data of [{ ["k".repeat(65)]: 1 }, JSON.parse('{"__proto__": 1}'), { constructor: 1 }]) {
      const r = await ctx.app.inject({ method: "PATCH", url: `/profiles/${p.id}/tab-state`, payload: JSON.stringify({ data }), headers: { "content-type": "application/json" } });
      expect(r.statusCode).toBe(400);
    }
  });
});
