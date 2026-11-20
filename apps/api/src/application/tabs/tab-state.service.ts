import {
  DomainError,
  ErrorCodes,
  TabStatePatchSchema,
  TabStateSchema,
  type BrowserTab,
  type Profile,
  type ResolvedValue,
  type TabState,
  type TabStateBulk,
} from "@queuepilot/contracts";
import type { Db } from "../../infrastructure/database.js";

/**
 * J3a — tab state per profile (Jancy's Tab object). A Deck tab is a profile
 * (ADR-0008), so the state is durable: it survives runs and API restarts and
 * goes with the profile on delete. Site extractors (J6) write `data` and
 * priority here; the console and the Deck read the label from it.
 */

export interface TabViewRow {
  profileId: string;
  profileName: string;
  email: string | null;
  /** The Deck tab label: `email · #queuePosition` (owner decision Q13). */
  label: string;
  runId: string | null;
  tabs: BrowserTab[];
  state: TabState;
}

export interface TabStateDeps {
  db: Db;
  profiles: { get(id: string): Profile; list(): Profile[] };
  /** Live tabs of the profile's active run ([] when not running). */
  liveTabs: (profileId: string) => BrowserTab[];
}

export class TabStateService {
  constructor(private readonly deps: TabStateDeps) {}

  get(profileId: string): TabState {
    this.deps.profiles.get(profileId); // 404 for an unknown profile
    return this.read(profileId);
  }

  /** Partial update; `data` merges key by key and a null value deletes the key. */
  patch(profileId: string, body: unknown): TabState {
    this.deps.profiles.get(profileId);
    const parsed = TabStatePatchSchema.safeParse(body);
    if (!parsed.success) throw validation(parsed.error.issues);
    const cur = this.read(profileId);
    const { data, ...rest } = parsed.data;
    const next: Record<string, unknown> = { ...cur, ...rest };
    if (data) {
      const merged: Record<string, unknown> = { ...cur.data };
      for (const [k, v] of Object.entries(data)) {
        if (v === null) delete merged[k];
        else merged[k] = v;
      }
      next.data = merged;
    }
    return this.write(profileId, next);
  }

  /** Records a resolved code (email / SMS / other) for the tab. */
  recordCode(profileId: string, kind: "emailCode" | "smsCode" | "otherCode", value: ResolvedValue): TabState {
    this.deps.profiles.get(profileId);
    const cur = this.read(profileId);
    return this.write(profileId, { ...cur, codes: { ...cur.codes, [kind]: value } });
  }

  clearCodes(profileId: string): TabState {
    this.deps.profiles.get(profileId);
    const cur = this.read(profileId);
    return this.write(profileId, { ...cur, codes: { emailCode: null, smsCode: null, otherCode: null } });
  }

  /**
   * The first unused passcode, marked used (autofill's `passcode` field,
   * J4). Null when every passcode is used or there are none.
   */
  takePasscode(profileId: string): string | null {
    this.deps.profiles.get(profileId);
    return this.deps.db.transaction(() => {
      const cur = this.read(profileId);
      const i = cur.passcodes.findIndex((p) => !p.used);
      if (i < 0) return null;
      const passcodes = cur.passcodes.map((p, j) => (j === i ? { ...p, used: true } : p));
      this.write(profileId, { ...cur, passcodes });
      return cur.passcodes[i]!.value;
    })();
  }

  /** Jancy bulk set: line i → tab i; for passcodes a comma gives several. */
  bulk(input: TabStateBulk): { updated: number } {
    for (const id of input.profileIds) this.deps.profiles.get(id);
    let updated = 0;
    this.deps.db.transaction(() => {
      input.profileIds.forEach((id, i) => {
        if (i >= input.lines.length && !input.repeat) return;
        const line = input.lines[i % input.lines.length]!;
        const cur = this.read(id);
        if (input.field === "notes") {
          this.write(id, { ...cur, notes: line });
        } else {
          const codes = line.split(",").map((s) => s.trim()).filter(Boolean);
          this.write(id, { ...cur, passcodes: codes.map((value) => ({ value, used: false })) });
        }
        updated++;
      });
    })();
    return { updated };
  }

  /** Cross-run Tab View: every running profile with its open tabs and state. */
  view(opts: { all?: boolean } = {}): TabViewRow[] {
    const rows: TabViewRow[] = [];
    for (const p of this.deps.profiles.list()) {
      const tabs = this.deps.liveTabs(p.id).filter((t) => t.status === "open");
      if (!opts.all && tabs.length === 0 && p.status !== "running") continue;
      const state = this.read(p.id);
      rows.push({
        profileId: p.id,
        profileName: p.name,
        email: p.email,
        label: deckLabel(p, state),
        runId: tabs[0]?.runId ?? null,
        tabs,
        state,
      });
    }
    // Jancy's default order: priority (high first), then name.
    return rows.sort((a, b) => (b.state.priority ?? -Infinity) - (a.state.priority ?? -Infinity) || a.profileName.localeCompare(b.profileName));
  }

  /** CSV of the given profiles' tab state (Jancy "export tabs"). */
  exportCsv(profileIds: string[]): string {
    const head = ["profile", "email", "notes", "passcodes", "priority", "priorityGroup", "queuePosition", "data"];
    const lines = [head.join(",")];
    for (const id of profileIds) {
      const p = this.deps.profiles.get(id);
      const s = this.read(id);
      lines.push(
        [
          p.name,
          p.email ?? "",
          s.notes,
          s.passcodes.map((c) => c.value).join(" "),
          s.priority ?? "",
          s.priorityGroup ?? "",
          s.data.queuePosition ?? "",
          JSON.stringify(s.data),
        ]
          .map(csvCell)
          .join(","),
      );
    }
    return lines.join("\r\n") + "\r\n";
  }

  private read(profileId: string): TabState {
    const row = this.deps.db.prepare("SELECT state FROM tab_state WHERE profile_id = ?").get(profileId) as { state: string } | undefined;
    if (!row) return TabStateSchema.parse({});
    try {
      const parsed = TabStateSchema.safeParse(JSON.parse(row.state));
      if (parsed.success) return parsed.data;
    } catch {
      /* fall through */
    }
    // Unreadable stored state: the next write replaces it, so say so.
    console.warn(`[tab-state] stored state for profile ${profileId} is unreadable; starting empty`);
    return TabStateSchema.parse({});
  }

  private write(profileId: string, state: unknown): TabState {
    const parsed = TabStateSchema.safeParse(state);
    if (!parsed.success) throw validation(parsed.error.issues);
    this.deps.db
      .prepare(
        `INSERT INTO tab_state (profile_id, state, updated_at) VALUES (?,?,?)
         ON CONFLICT(profile_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`,
      )
      .run(profileId, JSON.stringify(parsed.data), new Date().toISOString());
    return parsed.data;
  }
}

/** `email · #position` — the owner's tab label (Q13); falls back to the profile name. */
export function deckLabel(p: { name: string; email: string | null }, s: TabState): string {
  const who = p.email || p.name;
  const pos = s.data.queuePosition;
  return pos === undefined || pos === null || pos === "" ? who : `${who} · #${pos}`;
}

/** CSV cell with formula-injection guard (a leading = + - @ is quoted as text). */
function csvCell(v: unknown): string {
  let s = String(v ?? "");
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function validation(issues: { path: (string | number)[]; message: string }[]): DomainError {
  return new DomainError(ErrorCodes.VALIDATION_FAILED, issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
}
