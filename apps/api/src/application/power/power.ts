import fs from "node:fs";
import path from "node:path";
import { DomainError, ErrorCodes, type Settings } from "@queuepilot/contracts";

/**
 * J7 pieces that are plain data: the command catalogue, preference sets and
 * tab strings.
 */

/* ------------------------------ command registry --------------------------- */

export interface CommandDef {
  id: string;
  title: string;
  /** Extra arguments the palette asks for. */
  args: { name: string; type: "string" | "number"; optional?: boolean }[];
  /** The API call this command makes for ONE profile. */
  call: (profileId: string, args: Record<string, unknown>) => { method: "POST"; url: string; body: Record<string, unknown> };
}

const id = (p: string) => encodeURIComponent(p);

/** Built-ins (Jancy's A-6 list that QueuePilot has an API for). Each runs per selected profile. */
export const COMMANDS: CommandDef[] = [
  { id: "profile.start", title: "Start profile", args: [], call: (p) => ({ method: "POST", url: `/profiles/${id(p)}/start`, body: {} }) },
  { id: "profile.stop", title: "Stop profile", args: [], call: (p) => ({ method: "POST", url: `/profiles/${id(p)}/stop`, body: {} }) },
  { id: "tabs.clear-codes", title: "Clear resolved codes", args: [], call: (p) => ({ method: "POST", url: `/profiles/${id(p)}/tab-state/clear-codes`, body: {} }) },
  { id: "tabs.reopen", title: "Reopen closed tab", args: [], call: (p) => ({ method: "POST", url: `/profiles/${id(p)}/tabs/reopen`, body: {} }) },
  {
    id: "tabs.log-note",
    title: "Log note",
    args: [{ name: "note", type: "string" }],
    call: (p, a) => ({ method: "POST", url: `/profiles/${id(p)}/log-note`, body: { note: String(a.note ?? "") } }),
  },
  {
    id: "cookies.run-group",
    title: "Run cookie-thinger group",
    args: [{ name: "group", type: "number" }],
    call: (p, a) => ({ method: "POST", url: `/profiles/${id(p)}/cookie-thinger/run`, body: { group: Number(a.group) } }),
  },
  {
    id: "cookies.clear-tm",
    title: "Clear Ticketmaster cookies",
    args: [],
    call: (p) => ({ method: "POST", url: `/profiles/${id(p)}/cookies/clear`, body: { domain: "*.ticketmaster.com" } }),
  },
  {
    id: "autofill.map",
    title: "Autofill from the map",
    args: [{ name: "card", type: "string", optional: true }],
    call: (p, a) => ({ method: "POST", url: `/profiles/${id(p)}/autofill/map`, body: a.card ? { card: String(a.card) } : {} }),
  },
  { id: "deck.adopt", title: "Add to the Deck", args: [], call: (p) => ({ method: "POST", url: `/deck/profiles/${id(p)}/adopt`, body: {} }) },
];

export function commandById(cmd: string): CommandDef {
  const c = COMMANDS.find((x) => x.id === cmd);
  if (!c) throw new DomainError(ErrorCodes.VALIDATION_FAILED, `unknown command "${cmd}"`);
  return c;
}

/* ------------------------------- preference sets --------------------------- */

/**
 * Fields that never go into (or come out of) a preference set: credentials, the
 * team server address (a preset must not redirect the stored token) and the
 * scripting switch (which has its own token guard).
 */
const SECRET_FIELDS: Record<string, string[]> = { team: ["token", "syncPassphrase", "serverUrl"], automation: ["scriptingEndpoints"] };

export function presetSafe(section: string, value: unknown): Record<string, unknown> {
  const drop = new Set(SECRET_FIELDS[section] ?? []);
  return Object.fromEntries(Object.entries((value ?? {}) as object).filter(([k]) => !drop.has(k)));
}

export class PresetStore {
  constructor(private readonly dataDir: string) {}
  private get file(): string {
    return path.join(this.dataDir, "presets.json");
  }
  private read(): Record<string, Partial<Settings>> {
    try {
      return JSON.parse(fs.readFileSync(this.file, "utf8")) as Record<string, Partial<Settings>>;
    } catch {
      return {};
    }
  }
  private write(p: Record<string, Partial<Settings>>): void {
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(p, null, 2), "utf8");
  }
  list(): string[] {
    return Object.keys(this.read()).sort();
  }
  save(name: string, current: Settings): void {
    const snap: Record<string, unknown> = {};
    for (const [section, value] of Object.entries(current)) {
      snap[section] = presetSafe(section, value);
    }
    this.write({ ...this.read(), [name]: snap as Partial<Settings> });
  }
  get(name: string): Partial<Settings> {
    const all = this.read();
    const p = Object.hasOwn(all, name) ? all[name] : undefined;
    if (!p) throw new DomainError(ErrorCodes.VALIDATION_FAILED, `no preference set "${name}"`);
    return p;
  }
  delete(name: string): void {
    const all = this.read();
    delete all[name];
    this.write(all);
  }
}

/* --------------------------------- tab strings ----------------------------- */

const PREFIX = "qp1:";

/** A tab string: the open http(s) URLs of a profile, as one pasteable token. */
export function encodeTabString(urls: string[]): string {
  const ok = urls.filter((u) => /^https?:\/\//i.test(u)).slice(0, 100);
  return PREFIX + Buffer.from(JSON.stringify(ok), "utf8").toString("base64url");
}

export function decodeTabString(s: string): string[] {
  if (!s.startsWith(PREFIX)) throw new DomainError(ErrorCodes.VALIDATION_FAILED, "not a QueuePilot tab string");
  try {
    const v = JSON.parse(Buffer.from(s.slice(PREFIX.length), "base64url").toString("utf8")) as unknown;
    if (!Array.isArray(v)) throw new Error("not a list");
    // Only web pages: a pasted string must never open file:, chrome:, javascript: or data: URLs.
    return v.filter((u): u is string => typeof u === "string" && /^https?:\/\//i.test(u) && u.length <= 4000).slice(0, 100);
  } catch {
    throw new DomainError(ErrorCodes.VALIDATION_FAILED, "damaged tab string");
  }
}
