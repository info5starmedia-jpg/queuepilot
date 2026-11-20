import fs from "node:fs";
import path from "node:path";
import type { SecretStore } from "../secrets/secret-store.js";
import { clearCookies, listCookies, setCookie, type CookieRecord } from "./cookie-thinger.js";

/**
 * J5 — Jancy's cookie-thinger file: ten numbered groups of cookie actions
 * and five cookie lists, kept in `<dataDir>/cookie-thinger.txt`
 * (hot-reloaded). Jancy's own file syntax could not be fetched (the wiki
 * only names the actions), so this grammar is QueuePilot's, built on those
 * names; it is documented here and listed as an owner question.
 *
 *   ; comment
 *   [group 3]                       actions below belong to group 3 (1..10)
 *   del <name> <domain>             delete matching cookies (globs: *, case-insensitive)
 *   delall <domain>                 delete every cookie of the domain(s)
 *   copy <list> <name> <domain>     copy matching cookies INTO a list
 *   copyall <list> <domain>         copy every cookie of the domain into a list
 *   dcopy <list> <domain>           copy to the list, then delete from the profile (a move)
 *   paste <list>                    set the list's cookies into the profile
 *   lclear <list>                   empty a list
 *   ladd <list> <name> <domain> <value>
 *   lupdate <list>                  refresh the list's values from the profile's cookies
 *   lcopy <list> <list>             copy one list onto another
 *
 * Lists are `1`..`5` (temporary, in memory) or `$1`..`$5` (persistent: kept
 * sealed in the secret store, since cookie values are credentials).
 * Responses give counts and names, never values.
 */

export type ListId = "1" | "2" | "3" | "4" | "5" | "$1" | "$2" | "$3" | "$4" | "$5";
const LIST = /^\$?[1-5]$/;

export type ThingerAction =
  | { op: "del"; name: string; domain: string }
  | { op: "delall"; domain: string }
  | { op: "copy"; list: ListId; name: string; domain: string }
  | { op: "copyall"; list: ListId; domain: string }
  | { op: "dcopy"; list: ListId; domain: string }
  | { op: "paste"; list: ListId }
  | { op: "lclear"; list: ListId }
  | { op: "ladd"; list: ListId; name: string; domain: string; value: string }
  | { op: "lupdate"; list: ListId }
  | { op: "lcopy"; from: ListId; to: ListId };

export interface ThingerFile {
  groups: Map<number, { action: ThingerAction; line: number }[]>;
  errors: { line: number; message: string }[];
}

export function parseThinger(text: string): ThingerFile {
  const out: ThingerFile = { groups: new Map(), errors: [] };
  let group: number | null = null;
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = i + 1;
    const t = raw.trim();
    if (!t || t.startsWith(";")) return;
    const g = /^\[group\s+(\d+)\]$/i.exec(t);
    if (g) {
      const n = Number(g[1]);
      if (n < 1 || n > 10) out.errors.push({ line, message: "group must be 1..10" });
      else {
        group = n;
        if (!out.groups.has(n)) out.groups.set(n, []);
      }
      return;
    }
    const w = t.split(/\s+/);
    if ((t.match(/\*/g) ?? []).length > 6) {
      out.errors.push({ line, message: "too many * in one line (max 6)" });
      return;
    }
    const a = actionOf(w);
    if (typeof a === "string") out.errors.push({ line, message: a });
    else if (group === null) out.errors.push({ line, message: "action before any [group N]" });
    else out.groups.get(group)!.push({ action: a, line });
  });
  return out;
}

function actionOf(w: string[]): ThingerAction | string {
  const [op, ...a] = w as [string, ...string[]];
  const list = (s: string | undefined): ListId | null => (s && LIST.test(s) ? (s as ListId) : null);
  const need = (n: number) => (a.length === n ? null : `${op} takes ${n} argument${n === 1 ? "" : "s"}`);
  switch (op.toLowerCase()) {
    case "del":
      return need(2) ?? { op: "del", name: a[0]!, domain: a[1]! };
    case "delall":
      return need(1) ?? { op: "delall", domain: a[0]! };
    case "copy": {
      const l = list(a[0]);
      return need(3) ?? (l ? { op: "copy", list: l, name: a[1]!, domain: a[2]! } : "bad list (1-5 or $1-$5)");
    }
    case "copyall":
    case "dcopy": {
      const l = list(a[0]);
      return need(2) ?? (l ? { op: op.toLowerCase() as "copyall" | "dcopy", list: l, domain: a[1]! } : "bad list (1-5 or $1-$5)");
    }
    case "paste":
    case "lclear":
    case "lupdate": {
      const l = list(a[0]);
      return need(1) ?? (l ? { op: op.toLowerCase() as "paste" | "lclear" | "lupdate", list: l } : "bad list (1-5 or $1-$5)");
    }
    case "ladd": {
      const l = list(a[0]);
      return a.length < 4 ? "ladd takes <list> <name> <domain> <value>" : l ? { op: "ladd", list: l, name: a[1]!, domain: a[2]!, value: a.slice(3).join(" ") } : "bad list (1-5 or $1-$5)";
    }
    case "lcopy": {
      const f = list(a[0]);
      const t = list(a[1]);
      return need(2) ?? (f && t ? { op: "lcopy", from: f, to: t } : "bad list (1-5 or $1-$5)");
    }
    default:
      return `unknown action "${op}"`;
  }
}

/** What a run does to a profile's cookies (replaced by a fake in tests). */
export interface CookieOps {
  list(): Promise<CookieRecord[]>;
  clear(filter: { name?: string; domain?: string }): Promise<number>;
  set(c: CookieRecord): Promise<void>;
}

export interface RunSummary {
  group: number;
  actions: number;
  deleted: number;
  copied: number;
  pasted: number;
  errors: string[];
}

const DAY = 86_400;

export class CookieThinger {
  private readonly temp = new Map<string, CookieRecord[]>();
  private cache: { mtime: number; file: ThingerFile } | null = null;

  constructor(
    private readonly deps: { dataDir: string; secrets: SecretStore },
  ) {}

  private get filePath(): string {
    return path.join(this.deps.dataDir, "cookie-thinger.txt");
  }

  file(): ThingerFile {
    let mtime = 0;
    try {
      mtime = fs.statSync(this.filePath).mtimeMs;
    } catch {
      /* none yet */
    }
    if (!this.cache || this.cache.mtime !== mtime) this.cache = { mtime, file: parseThinger(mtime ? fs.readFileSync(this.filePath, "utf8") : "") };
    return this.cache.file;
  }

  status(): { exists: boolean; groups: Record<number, number>; errors: ThingerFile["errors"]; lists: Record<string, number> } {
    const f = this.file();
    return {
      exists: fs.existsSync(this.filePath),
      groups: Object.fromEntries([...f.groups].map(([g, a]) => [g, a.length])),
      errors: f.errors,
      lists: Object.fromEntries((["1", "2", "3", "4", "5", "$1", "$2", "$3", "$4", "$5"] as ListId[]).map((l) => [l, this.getList(l).length])),
    };
  }

  save(text: string): ReturnType<CookieThinger["status"]> {
    const parsed = parseThinger(text);
    if (parsed.errors.length) throw new Error(`cookie-thinger file has errors: ${parsed.errors.slice(0, 5).map((e) => `line ${e.line}: ${e.message}`).join("; ")}`);
    fs.mkdirSync(this.deps.dataDir, { recursive: true });
    fs.writeFileSync(this.filePath, text, "utf8");
    this.cache = null;
    return this.status();
  }

  getList(id: ListId): CookieRecord[] {
    if (!id.startsWith("$")) return this.temp.get(id) ?? [];
    const raw = this.deps.secrets.get(`cookielist.${id}`);
    try {
      return raw ? (JSON.parse(raw) as CookieRecord[]) : [];
    } catch {
      return [];
    }
  }

  private putList(id: ListId, cookies: CookieRecord[]): void {
    if (!id.startsWith("$")) this.temp.set(id, cookies);
    else if (cookies.length) this.deps.secrets.set(`cookielist.${id}`, JSON.stringify(cookies));
    else this.deps.secrets.delete(`cookielist.${id}`);
  }

  /** Run one group's actions, in order, against one profile. A failing action is reported and the rest still run. */
  async run(group: number, ops: CookieOps): Promise<RunSummary> {
    const actions = this.file().groups.get(group);
    const sum: RunSummary = { group, actions: actions?.length ?? 0, deleted: 0, copied: 0, pasted: 0, errors: [] };
    if (!actions) {
      sum.errors.push(`group ${group} is not in the file`);
      return sum;
    }
    for (const { action: a, line } of actions) {
      try {
        await this.apply(a, ops, sum);
      } catch (e) {
        sum.errors.push(`line ${line}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return sum;
  }

  private async apply(a: ThingerAction, ops: CookieOps, sum: RunSummary): Promise<void> {
    switch (a.op) {
      case "del":
        sum.deleted += await ops.clear({ name: a.name, domain: a.domain });
        break;
      case "delall":
        sum.deleted += await ops.clear({ domain: a.domain });
        break;
      case "copy":
      case "copyall":
      case "dcopy": {
        const found = (await ops.list()).filter((c) => globRe(a.domain).test(c.domain.replace(/^\./, "")) && (a.op !== "copy" || globRe(a.name).test(c.name)));
        this.putList(a.list, mergeCookies(this.getList(a.list), found));
        sum.copied += found.length;
        if (a.op === "dcopy") sum.deleted += await ops.clear({ domain: a.domain });
        break;
      }
      case "paste": {
        for (const c of this.getList(a.list)) {
          await ops.set(c);
          sum.pasted++;
        }
        break;
      }
      case "lclear":
        this.putList(a.list, []);
        break;
      case "ladd":
        this.putList(a.list, mergeCookies(this.getList(a.list), [{ name: a.name, value: a.value, domain: a.domain, path: "/", expires: Math.floor(Date.now() / 1000) + 30 * DAY, secure: true, httpOnly: false, browserContextId: null }]));
        break;
      case "lupdate": {
        const live = await ops.list();
        this.putList(a.list, this.getList(a.list).map((c) => live.find((l) => l.name === c.name && l.domain === c.domain && l.path === c.path) ?? c));
        break;
      }
      case "lcopy":
        this.putList(a.to, [...this.getList(a.from)]);
        break;
    }
  }
}

/** `*` glob, case-insensitive, whole string (leading dots ignored on both sides). */
export function globRe(pattern: string): RegExp {
  // (cookie names/domains come from pages: the patterns are bounded by the 6-star line cap above)
  const p = pattern.replace(/^\./, "").replace(/\*{2,}/g, "*");
  const esc = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  // "*.shop.com" means the domain and its subdomains, so bare "shop.com" matches too.
  if (p.startsWith("*.")) return new RegExp(`^(.*\\.)?${p.slice(2).split("*").map(esc).join(".*")}$`, "i");
  return new RegExp(`^${p.split("*").map(esc).join(".*")}$`, "i");
}

function mergeCookies(into: CookieRecord[], more: CookieRecord[]): CookieRecord[] {
  const key = (c: CookieRecord) => `${c.domain}|${c.path}|${c.name}`;
  const m = new Map(into.map((c) => [key(c), c]));
  for (const c of more) m.set(key(c), c);
  return [...m.values()];
}

/** Real CDP-backed ops for a running profile. */
export function cdpCookieOps(wsEndpoint: string): CookieOps {
  return {
    list: () => listCookies(wsEndpoint),
    clear: async (f) => {
      // The Cookie Thinger glob also matches a leading-dot domain, as `listCookies` does.
      return clearCookies(wsEndpoint, { ...(f.name ? { name: f.name } : {}), ...(f.domain ? { domain: f.domain } : {}) });
    },
    set: (c) => setCookie(wsEndpoint, { name: c.name, value: c.value, domain: c.domain, path: c.path, expires: c.expires, secure: c.secure, httpOnly: c.httpOnly }),
  };
}

/* ------------------------- cookies-for-profiles CSV ------------------------ */

/**
 * Cookies-for-profiles CSV: header `group,profile,email,name,value,domain,path`
 * (path optional). A row goes to the profile whose Group + Name both match,
 * else the profile whose email matches. Returns the rows per profile id and
 * the rows nobody matched.
 */
export function matchCookieCsv(
  csv: string,
  profiles: { id: string; name: string; group: string | null; email: string | null }[],
): { byProfile: Map<string, CookieRecord[]>; unmatched: number } {
  const rows = parseCsv(csv);
  const head = rows.shift()?.map((h) => h.trim().toLowerCase()) ?? [];
  const col = (r: string[], n: string) => (r[head.indexOf(n)] ?? "").trim();
  const byProfile = new Map<string, CookieRecord[]>();
  let unmatched = 0;
  for (const r of rows) {
    const [grp, nm, em] = [col(r, "group"), col(r, "profile"), col(r, "email").toLowerCase()];
    const p =
      (grp && nm ? profiles.find((x) => (x.group ?? "") === grp && x.name === nm) : undefined) ??
      (em ? profiles.find((x) => (x.email ?? "").toLowerCase() === em) : undefined);
    const name = col(r, "name");
    const domain = col(r, "domain");
    if (!p || !name || !domain) {
      unmatched++;
      continue;
    }
    const list = byProfile.get(p.id) ?? [];
    list.push({ name, value: col(r, "value"), domain, path: col(r, "path") || "/", expires: 0, secure: true, httpOnly: false, browserContextId: null });
    byProfile.set(p.id, list);
  }
  return { byProfile, unmatched };
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (q) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      if (row.some((x) => x !== "")) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x !== "")) rows.push(row);
  return rows;
}
