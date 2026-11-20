import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DeckService, type DeckHost } from "../src/application/deck/deck.service.js";
import { DECK_HOST_SCRIPT } from "../src/application/deck/deck-host-script.js";

/** ADR-0008 — the Deck's API side, with the PowerShell host replaced by a fake. */
function setup(over: { deckEnabled?: boolean; platform?: NodeJS.Platform } = {}) {
  const sent: Record<string, unknown>[] = [];
  let lineCb: (l: string) => void = () => {};
  let exitCb: () => void = () => {};
  let killed = 0;
  const host: DeckHost = {
    send: (l) => void sent.push(JSON.parse(l) as Record<string, unknown>),
    onLine: (cb) => (lineCb = cb),
    onExit: (cb) => (exitCb = cb),
    kill: () => void killed++,
  };
  const events = new EventEmitter();
  let label = "a@x.com · #12";
  const runs = new Map([["11111111-1111-4111-8111-111111111111", { pid: 4242, status: "running" }]]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deck-"));
  const deck = new DeckService({
    lifecycle: { activeRun: (id) => runs.get(id) ?? null, events: { on: (_e, cb) => events.on("lifecycle", cb) } },
    labels: () => [{ profileId: "11111111-1111-4111-8111-111111111111", label }],
    settings: () => ({ deckEnabled: over.deckEnabled ?? true }),
    dataDir: dir,
    platform: over.platform ?? "win32",
    startHost: () => host,
    runGroup: async (_s, pids) => ({ grouped: pids }),
  });
  deck.start();
  return { deck, sent, events, dir, setLabel: (l: string) => (label = l), reply: (o: object) => lineCb(JSON.stringify(o)), exit: () => exitCb(), killed: () => killed };
}
const ID = "11111111-1111-4111-8111-111111111111";

describe("Profile Deck service", () => {
  it("adopts a started profile with its tab label and tracks the host's answers", async () => {
    const t = setup();
    t.events.emit("lifecycle", { type: "run.started", profileId: ID });
    await new Promise((r) => setTimeout(r, 5));
    expect(t.sent).toEqual([{ cmd: "adopt", id: ID, pid: 4242, label: "a@x.com · #12" }]);
    t.reply({ event: "ready" });
    t.reply({ event: "adopted", id: ID, ok: true });
    expect(t.deck.status()).toMatchObject({ open: true, tabs: [{ profileId: ID, label: "a@x.com · #12", adopted: true }] });
    // The script is written once, with a BOM (PowerShell 5.1 reads BOM-less files as ANSI).
    expect(fs.readFileSync(path.join(t.dir, "deck-host.ps1"), "utf8")).toBe(`﻿${DECK_HOST_SCRIPT}`);
  });

  it("does nothing when the Deck setting is off, and removes the tab when the run ends", async () => {
    const off = setup({ deckEnabled: false });
    off.events.emit("lifecycle", { type: "run.started", profileId: ID });
    await new Promise((r) => setTimeout(r, 5));
    expect(off.sent).toEqual([]);

    const t = setup();
    await t.deck.adopt(ID);
    t.events.emit("lifecycle", { type: "run.stopped", profileId: ID });
    expect(t.sent.at(-1)).toEqual({ cmd: "remove", id: ID });
    expect(t.deck.status().tabs).toEqual([]);
  });

  it("pushes label changes and resets when the host exits or closes", async () => {
    const t = setup();
    await t.deck.adopt(ID);
    t.setLabel("a@x.com · #3");
    (t.deck as unknown as { refreshLabels(): void }).refreshLabels();
    expect(t.sent.at(-1)).toEqual({ cmd: "label", id: ID, label: "a@x.com · #3" });
    t.reply({ event: "closed" });
    expect(t.deck.status()).toMatchObject({ open: false, tabs: [] });
    expect(t.killed()).toBe(1);
  });

  it("is Windows-only and refuses a profile that is not running", async () => {
    await expect(setup({ platform: "linux" }).deck.adopt(ID)).rejects.toThrow();
    await expect(setup().deck.adopt("22222222-2222-4222-8222-222222222222")).rejects.toThrow(/start the profile/);
    expect((await setup().deck.groupTaskbar([1, 2])) as { grouped: number[] }).toEqual({ grouped: [1, 2] });
  });

  it("the host script has no characters that would break a template literal", () => {
    expect(DECK_HOST_SCRIPT).not.toContain("`");
    expect(DECK_HOST_SCRIPT).not.toContain("${");
  });
});
