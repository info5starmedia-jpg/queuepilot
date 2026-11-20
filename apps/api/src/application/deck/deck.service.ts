import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { LifecycleEvent } from "@queuepilot/contracts";
import { DomainError, ErrorCodes } from "@queuepilot/contracts";
import { DECK_HOST_SCRIPT } from "./deck-host-script.js";

/**
 * ADR-0008 Profile Deck. One container window, a tab per running profile
 * (label `email · #queuePosition`, from tab state). Engines stay separate
 * processes: the host script only re-parents their top-level window.
 * Windows only; elsewhere every call is a clear error and nothing changes.
 */

export type DeckEvent = { event: "ready" | "closed" } | { event: "adopted"; id: string; ok: boolean } | { event: "selected" | "gone"; id: string };

/** The seam the tests replace: how the host process is started. */
export interface DeckHost {
  send(line: string): void;
  onLine(cb: (line: string) => void): void;
  onExit(cb: () => void): void;
  kill(): void;
}

export interface DeckDeps {
  lifecycle: {
    activeRun(id: string): { pid?: number | null; status: string } | null | undefined;
    events: { on(ev: "lifecycle", cb: (e: LifecycleEvent) => void): unknown };
  };
  /** Running profiles with their current tab label (TabStateService.view). */
  labels: () => { profileId: string; label: string }[];
  settings: () => { deckEnabled: boolean };
  dataDir: string;
  platform?: NodeJS.Platform;
  startHost?: (scriptPath: string) => DeckHost;
  runGroup?: (scriptPath: string, pids: number[]) => Promise<unknown>;
}

const POWERSHELL = ["-STA", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File"];

function realHost(script: string): DeckHost {
  const child = spawn("powershell.exe", [...POWERSHELL, script, "-Mode", "deck"], {
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
  });
  let buf = "";
  return {
    send: (l) => void child.stdin.write(`${l}\n`),
    onLine: (cb) =>
      child.stdout.on("data", (d: Buffer) => {
        buf += d.toString("utf8");
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          cb(buf.slice(0, i).trim());
          buf = buf.slice(i + 1);
        }
      }),
    onExit: (cb) => child.on("exit", cb),
    kill: () => child.kill(),
  };
}

function realGroup(script: string, pids: number[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile("powershell.exe", [...POWERSHELL, script, "-Mode", "group", "-Pids", pids.join(",")], { windowsHide: true, timeout: 30_000 }, (err, out) => {
      if (err) return reject(err);
      try {
        resolve(JSON.parse(out.trim().split("\n").pop() ?? "{}"));
      } catch {
        reject(new Error("taskbar grouping helper returned no result"));
      }
    });
  });
}

export class DeckService {
  private host: DeckHost | null = null;
  private ready = false;
  private readonly tabs = new Map<string, { label: string; adopted: boolean | null; since: number; pid: number }>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: DeckDeps) {}

  private get supported(): boolean {
    return (this.deps.platform ?? process.platform) === "win32";
  }

  /** Auto-adopt launches while Settings → Launch → Deck is on; drop tabs when a run ends. */
  start(): void {
    this.deps.lifecycle.events.on("lifecycle", (e) => {
      if (e.type === "run.started" && this.deps.settings().deckEnabled && this.supported) void this.adopt(e.profileId).catch(() => {});
      else if (e.type === "run.stopped" || e.type === "run.crashed") this.remove(e.profileId);
    });
  }

  status(): { supported: boolean; open: boolean; tabs: { profileId: string; label: string; adopted: boolean | null }[] } {
    return {
      supported: this.supported,
      open: this.host !== null && this.ready,
      tabs: [...this.tabs].map(([profileId, t]) => ({ profileId, label: t.label, adopted: t.adopted })),
    };
  }

  /** Open the container and adopt every running profile. */
  open(runningIds: string[]): void {
    this.ensureHost();
    for (const id of runningIds) void this.adopt(id).catch(() => {});
  }

  async adopt(profileId: string): Promise<void> {
    const run = this.deps.lifecycle.activeRun(profileId);
    if (!run || run.status !== "running" || !run.pid) throw new DomainError(ErrorCodes.PROFILE_NOT_RUNNING, "start the profile first");
    this.ensureHost();
    const label = this.labelOf(profileId);
    this.tabs.set(profileId, { label, adopted: null, since: Date.now(), pid: run.pid });
    this.host!.send(JSON.stringify({ cmd: "adopt", id: profileId, pid: run.pid, label }));
  }

  remove(profileId: string): void {
    if (!this.tabs.delete(profileId)) return;
    this.host?.send(JSON.stringify({ cmd: "remove", id: profileId }));
  }

  select(profileId: string): void {
    if (this.tabs.has(profileId)) this.host?.send(JSON.stringify({ cmd: "select", id: profileId }));
  }

  close(): void {
    this.host?.send(JSON.stringify({ cmd: "quit" }));
    this.reset();
  }

  /** Step 1 quick win: one taskbar group for all running profile windows. */
  async groupTaskbar(pids: number[]): Promise<unknown> {
    this.requireSupported();
    return (this.deps.runGroup ?? realGroup)(this.scriptPath(), pids);
  }

  private labelOf(id: string): string {
    const raw = this.deps.labels().find((l) => l.profileId === id)?.label ?? id.slice(0, 8);
    // Page-derived text: WinForms treats & as a mnemonic and a long label widens the strip.
    return raw.replace(/&/g, "&&").slice(0, 60);
  }

  private requireSupported(): void {
    if (!this.supported) throw new DomainError(ErrorCodes.VALIDATION_FAILED, "the Profile Deck is Windows-only for now");
  }

  private scriptPath(): string {
    const file = path.join(this.deps.dataDir, "deck-host.ps1");
    fs.mkdirSync(this.deps.dataDir, { recursive: true });
    // UTF-8 BOM: Windows PowerShell 5.1 reads BOM-less files as ANSI.
    const body = `﻿${DECK_HOST_SCRIPT}`;
    if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== body) fs.writeFileSync(file, body, "utf8");
    return file;
  }

  private ensureHost(): void {
    this.requireSupported();
    if (this.host) return;
    const host = (this.deps.startHost ?? realHost)(this.scriptPath());
    this.host = host;
    host.onLine((l) => this.onLine(l));
    host.onExit(() => {
      if (this.host === host) this.reset();
    });
    this.timer = setInterval(() => this.refreshLabels(), 5000);
    this.timer.unref();
  }

  private onLine(line: string): void {
    let ev: DeckEvent;
    try {
      ev = JSON.parse(line) as DeckEvent;
    } catch {
      return;
    }
    if (ev.event === "ready") this.ready = true;
    else if (ev.event === "adopted") {
      const t = this.tabs.get(ev.id);
      if (t) t.adopted = ev.ok;
    } else if (ev.event === "gone") this.tabs.delete(ev.id);
    else if (ev.event === "closed") this.reset();
  }

  private refreshLabels(): void {
    if (!this.host) return;
    // An adopt the host never answered (it was observed to drop one when two
    // arrived back to back) is sent again; the host ignores duplicates.
    for (const [id, t] of this.tabs) {
      if (t.adopted === null && Date.now() - t.since > 8000) {
        t.since = Date.now();
        this.host.send(JSON.stringify({ cmd: "adopt", id, pid: t.pid, label: t.label }));
      }
    }
    for (const l of this.deps.labels()) {
      const t = this.tabs.get(l.profileId);
      if (t && t.label !== l.label) {
        t.label = l.label;
        this.host.send(JSON.stringify({ cmd: "label", id: l.profileId, label: l.label }));
      }
    }
  }

  private reset(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.host?.kill();
    this.host = null;
    this.ready = false;
    this.tabs.clear();
  }
}
