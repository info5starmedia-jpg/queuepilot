import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { makeTestContext } from "./helpers.js";
import { interpretProbe, siteKindOf, readCartSeconds, readQueuePosition, readEvent } from "../src/application/siteplugins/extractors.js";
import { cleanProbe } from "../src/application/siteplugins/site-plugin.service.js";
import { decryptExport, encryptExport, isDiscordWebhook, safeText } from "../src/application/discord/discord.service.js";

/** J6 — site readers, queue-position log, events and Discord (fixtures; not live-verified). */

const FAKE_HOOK = "https://discord.com/api/webhooks/123456789012345678/" + "a".repeat(68);

const queueProbe = (ahead: string, text = "") => ({
  url: "https://queue.ticketmaster.com/?c=tm&e=abc",
  title: "Queue",
  text,
  qi: { ahead, queueNumber: null, wait: null, progress: "40" },
  timers: [],
  ld: [],
});

describe("site readers", () => {
  it("recognises sites and reads positions, timers and events", () => {
    expect(siteKindOf("https://queue.ticketmaster.co.uk/x")).toBe("queue");
    expect(siteKindOf("https://abc.queue-it.net/?c=1")).toBe("queue");
    expect(siteKindOf("https://www.ticketmaster.com/event/1A2B3C4D5E6F7A8B")).toBe("ticketmaster");
    expect(siteKindOf("https://www.example.com")).toBeNull();
    expect(siteKindOf("file:///x")).toBeNull();

    expect(readQueuePosition(queueProbe("1,234"))).toBe(1234);
    expect(readQueuePosition({ url: "https://queue.ticketmaster.com/", title: "", text: "There are 5,120 people ahead of you" })).toBe(5120);
    expect(readCartSeconds({ url: "https://www.ticketmaster.com/checkout", title: "", text: "", timers: [{ value: "7:45", context: "Time left to complete your purchase 7:45" }] })).toBe(465);
    const ev = readEvent({
      url: "https://www.ticketmaster.com/x/event/1A2B3C4D5E6F7A8B",
      title: "t",
      text: "",
      ld: [JSON.stringify({ "@type": "MusicEvent", name: "Big Tour", performer: { name: "Band" }, location: { name: "Arena" } })],
    });
    expect(ev).toMatchObject({ eventId: "1A2B3C4D5E6F7A8B", eventName: "Big Tour", artistName: "Band", venueName: "Arena" });
    expect(interpretProbe("queue", queueProbe("10", "It's your turn")).turn).toBe(true);
  });
});

describe("site plug-in loop", () => {
  it("writes tab state, logs positions to CSV, and emits position / passed / cart events", async () => {
    const ctx = makeTestContext();
    const p = ctx.profiles.create({ name: "fan-1", generateFingerprint: true });
    await ctx.lifecycle.start(p.id);
    const events: string[] = [];
    ctx.lifecycle.events.on("lifecycle", (e) => events.push(e.type));

    ctx.fakePages.pages = [{ targetId: "t1", url: "https://queue.ticketmaster.com/q", probe: queueProbe("900") }];
    await ctx.sites.tick();
    expect(ctx.tabState.get(p.id)).toMatchObject({ data: { queuePosition: 900, stage: "queue" }, priorityGroup: "queue" });
    ctx.fakePages.pages[0]!.probe = queueProbe("120");
    await ctx.sites.tick();
    expect(ctx.sites.positions(p.id).map((x) => x.position)).toEqual([900, 120]);
    expect(fs.readFileSync(path.join(ctx.dataDir, "queue-positions", "unknown.csv"), "utf8").split("\r\n").length).toBe(4);

    ctx.fakePages.pages = [
      {
        targetId: "t2",
        url: "https://www.ticketmaster.com/checkout/1",
        probe: { url: "https://www.ticketmaster.com/checkout/1", title: "", text: "", timers: [{ value: "9:30", context: "Time remaining 9:30" }], ld: [] },
      },
    ];
    await ctx.sites.tick();
    expect(ctx.tabState.get(p.id).data).toMatchObject({ stage: "cart", cartTimer: "9:30" });
    expect(events).toEqual(expect.arrayContaining(["queue.position", "queue.passed", "cart.timer"]));
    // Probes run only on known sites; page actions stay off by default.
    expect(ctx.fakePages.evaluated.every((e) => e.startsWith("(() => {\n  const t ="))).toBe(true);
    await ctx.lifecycle.stop(p.id);
  });
});

describe("Discord", () => {
  it("accepts only Discord webhook URLs and masks the stored one", async () => {
    expect(isDiscordWebhook(FAKE_HOOK)).toBe(true);
    for (const bad of ["http://discord.com/api/webhooks/123456789/" + "a".repeat(40), "https://evil.com/api/webhooks/123456789/" + "a".repeat(40), FAKE_HOOK + "?x=1", "https://u:p@discord.com/api/webhooks/123456789/" + "a".repeat(40)]) {
      expect(isDiscordWebhook(bad), bad).toBe(false);
    }
    const ctx = makeTestContext();
    expect((await ctx.app.inject({ method: "PUT", url: "/integrations/discord", payload: { webhookUrl: "https://evil.com/x" } })).statusCode).toBe(400);
    const put = await ctx.app.inject({ method: "PUT", url: "/integrations/discord", payload: { webhookUrl: FAKE_HOOK } });
    expect(put.statusCode).toBe(200);
    expect(put.body).not.toContain("a".repeat(20));
    expect((await ctx.app.inject({ method: "GET", url: "/integrations/discord" })).body).not.toContain("a".repeat(20));
    const r = await ctx.app.inject({ method: "GET", url: "/integrations/discord", headers: { "sec-fetch-site": "cross-site" } });
    expect(r.statusCode).toBe(403);
  });

  it("posts only the configured events, throttles positions, never mentions anyone", async () => {
    const ctx = makeTestContext();
    ctx.discord.setWebhook(FAKE_HOOK);
    const p = ctx.profiles.create({ name: "fan", generateFingerprint: true });
    const ev = (type: "queue.passed" | "queue.position" | "run.started") => ({ type, profileId: p.id, runId: null, at: new Date().toISOString(), detail: "x" });
    ctx.discord.onEvent(ev("queue.passed"));
    expect(ctx.discordCalls).toHaveLength(0); // discordEnabled is off by default
    ctx.settings.patch("sites", { discordEnabled: true });
    ctx.discord.onEvent(ev("queue.passed"));
    ctx.discord.onEvent(ev("run.started")); // not in the default list
    ctx.discord.onEvent(ev("queue.position")); // positionEveryMin 0 = never
    await new Promise((r) => setTimeout(r, 20));
    expect(ctx.discordCalls).toHaveLength(1);
    const body = JSON.parse(String(ctx.discordCalls[0]!.init.body)) as { content: string; allowed_mentions: { parse: string[] } };
    expect(body.content).toContain("Queue passed");
    expect(body.allowed_mentions.parse).toEqual([]);
  });

  it("cookie export is opt-in and token-gated; encrypted files round-trip", async () => {
    const ctx = makeTestContext();
    const p = ctx.profiles.create({ name: "c", generateFingerprint: true });
    const r = await ctx.app.inject({ method: "POST", url: `/profiles/${p.id}/discord/export`, payload: {} });
    expect(r.statusCode).toBe(403); // no SPECTRA_API_TOKEN in tests
    await expect(ctx.discord.exportCookies({ profileName: "c", exitIp: null, proxyName: null, cookies: [], format: "json" })).rejects.toThrow(/off/);

    const enc = encryptExport('[{"name":"sid","value":"v"}]', "correct horse");
    expect(JSON.stringify(enc)).not.toContain("sid");
    expect(decryptExport(enc, "correct horse")).toContain("sid");
    expect(() => decryptExport(enc, "wrong password")).toThrow(/wrong password/);
  });
});

describe("J6 audit regressions", () => {
  it("H1: look-alike hosts and plain http are not site pages", () => {
    expect(siteKindOf("https://ticketmaster.evil.com/event/1")).toBeNull();
    expect(siteKindOf("https://x.livenation.attacker.io/")).toBeNull();
    expect(siteKindOf("http://www.ticketmaster.com/event/1")).toBeNull();
    expect(siteKindOf("https://www.ticketmaster.co.uk/event/1")).toBe("ticketmaster");
  });

  it("M4/L2: a hostile probe is clamped, stripped of its query and cannot crash the reader", () => {
    expect(cleanProbe({ url: 1, text: "x" })).toBeNull();
    const c = cleanProbe({ url: `https://queue.ticketmaster.com/${"a".repeat(5000)}?token=secret#h`, title: "t", text: "y".repeat(99999), timers: "no", ld: [5, "ok"], qi: { ahead: 7 } })!;
    expect(c.url.length).toBeLessThanOrEqual(512);
    expect(c.url).not.toContain("token");
    expect(c.text.length).toBe(20000);
    expect(c.timers).toEqual([]);
    expect(c.ld).toEqual(["ok"]);
    expect(c.qi?.ahead).toBeNull();
    const deep = "[".repeat(50000) + "]".repeat(50000);
    expect(() => interpretProbe("ticketmaster", { url: "https://www.ticketmaster.com/", title: "", text: "", ld: [deep] })).not.toThrow();
    const t0 = Date.now();
    readQueuePosition({ url: "https://queue.ticketmaster.com/", title: "", text: "1,".repeat(10000) + " people in the line" });
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it("M3: page text cannot forge markdown, links or lines in a Discord message", () => {
    const t = safeText("Big Show\n**@everyone** [click](https://evil.example/x)");
    expect(t).not.toContain("\n");
    expect(t).not.toContain("://");
    expect(t).toContain("\\[");
  });

  it("M1/M2: rebinding Hosts and look-alike loopback origins are refused; /settings is browser-denied", async () => {
    const ctx = makeTestContext();
    const get = (headers: Record<string, string>, url = "/integrations/discord") => ctx.app.inject({ method: "GET", url, headers });
    expect((await get({ host: "evil.example.com:50325" })).statusCode).toBe(403);
    expect((await get({ host: "127.0.0.1:50325", origin: "http://127.evil.com" })).statusCode).toBe(403);
    expect((await get({ host: "127.0.0.1:50325", origin: "http://localhost:3000", "sec-fetch-site": "cross-site" }, "/settings/sections")).statusCode).toBe(403);
    expect((await get({ host: "127.0.0.1:50325" }, "/settings/sections")).statusCode).toBe(200);
  });

  it("L3: a decrypt file with a truncated tag or IV is refused", () => {
    const enc = encryptExport("hello", "correct horse");
    expect(() => decryptExport({ ...enc, tag: Buffer.alloc(4).toString("base64") }, "correct horse")).toThrow(/wrong password/);
    expect(() => decryptExport({ ...enc, iv: Buffer.alloc(8).toString("base64") }, "correct horse")).toThrow(/wrong password/);
  });
});
