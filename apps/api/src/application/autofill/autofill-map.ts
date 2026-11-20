/**
 * J4 — Jancy's autofill map file (`<dataDir>/autofill.map`), as documented at
 * docs.jancy.io/autofill/autofill-map, so the wiki's published site maps load
 * unchanged.
 *
 *   ; comment
 *   url=https://*.example.com/*        starts a block (`url=any` = the default block)
 *   include <url>                      inherit another block's rules
 *   dont-include-any                   don't auto-include the `any` block
 *   traverse-shadow-doms               look inside open shadow roots
 *   human firstName, lastName          per-field fill mode (typed like a person)
 *   machine email                      (set directly with native setter + events)
 *   swap firstName=lastName            field swapping: this field reads that one
 *   name=/first.?name/i ...            see below
 *
 * Rule:   <attr>=<regex | "quoted">; <field | "literal" | true|1|false|0>[; <format>]
 * Button: <attr>=<pattern>; button[; clicks]       (after filling, in file order)
 * XPath:  `//input[@x]`; <field | "literal" | bool>[; <format>]
 * Format: a JS function body taking (field, allFields), run in an ISOLATED
 * world of the page (own globals, so the page cannot swap Function/String to
 * read the values) — never in this process.
 *
 * Parsing is pure and returns errors per line; a bad line never loads half a
 * rule. The page half is a single Runtime.evaluate that reports field NAMES
 * filled/missing — never values.
 */

export type FillMode = "human" | "machine";

export interface MapRule {
  kind: "attr" | "xpath" | "button";
  /** Attribute to test (attr rules). */
  attr?: string;
  /** Regex source (attr rules) — `quoted` patterns are escaped and anchored. */
  pattern?: string;
  xpath?: string;
  /** Profile field name, or a literal when `literal` is set. */
  field?: string;
  literal?: string;
  bool?: boolean;
  format?: string;
  clicks?: number;
  line: number;
}

export interface MapBlock {
  name: string;
  glob: string;
  includes: string[];
  dontIncludeAny: boolean;
  traverseShadow: boolean;
  human: Set<string>;
  machine: Set<string>;
  rules: MapRule[];
}

export interface ParsedMap {
  blocks: MapBlock[];
  swaps: Record<string, string>;
  errors: { line: number; message: string }[];
}

const FIELD_NAME = /^[A-Za-z][A-Za-z0-9]*$/;

export function parseMap(text: string): ParsedMap {
  const out: ParsedMap = { blocks: [], swaps: {}, errors: [] };
  const any: MapBlock = newBlock("any", "any");
  out.blocks.push(any);
  let cur = any;
  const err = (line: number, message: string) => out.errors.push({ line, message });
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = i + 1;
    const t = raw.trim();
    if (!t || t.startsWith(";")) return;
    let m: RegExpExecArray | null;
    if ((m = /^url\s*=\s*(.+)$/i.exec(t))) {
      const glob = m[1]!.trim();
      cur = glob.toLowerCase() === "any" ? any : newBlock(glob, glob);
      if (cur !== any) out.blocks.push(cur);
    } else if ((m = /^include\s+(.+)$/i.exec(t))) cur.includes.push(m[1]!.trim());
    else if (/^dont-include-any$/i.test(t)) cur.dontIncludeAny = true;
    else if (/^traverse-shadow-doms$/i.test(t)) cur.traverseShadow = true;
    else if ((m = /^(human|machine)\s+(.+)$/i.exec(t))) {
      const set = m[1]!.toLowerCase() === "human" ? cur.human : cur.machine;
      for (const f of m[2]!.split(",").map((s) => s.trim()).filter(Boolean)) {
        if (FIELD_NAME.test(f)) set.add(f);
        else err(line, `bad field name "${f}"`);
      }
    } else if ((m = /^swap\s+([A-Za-z][A-Za-z0-9]*)\s*=\s*([A-Za-z][A-Za-z0-9]*)$/i.exec(t))) out.swaps[m[1]!] = m[2]!;
    else {
      const rule = parseRule(t, line, (msg) => err(line, msg));
      if (rule) cur.rules.push(rule);
    }
  });
  return out;
}

function newBlock(name: string, glob: string): MapBlock {
  return { name, glob, includes: [], dontIncludeAny: false, traverseShadow: false, human: new Set(), machine: new Set(), rules: [] };
}

function parseRule(t: string, line: number, fail: (m: string) => void): MapRule | null {
  const bad = (m: string): null => {
    fail(m);
    return null;
  };
  let kind: MapRule["kind"] = "attr";
  let attr: string | undefined;
  let pattern: string | undefined;
  let xpath: string | undefined;
  let rest: string;
  let m: RegExpExecArray | null;
  if (t.startsWith("`")) {
    const end = t.indexOf("`", 1);
    if (end < 0) return bad("unterminated xpath");
    kind = "xpath";
    xpath = t.slice(1, end);
    rest = t.slice(end + 1).replace(/^\s*;/, "");
  } else if ((m = /^([A-Za-z][\w-]*)\s*=\s*("(?:[^"\\]|\\.)*"|[^;]*);(.*)$/.exec(t))) {
    attr = m[1]!;
    const p = m[2]!.trim();
    pattern = p.startsWith('"') ? `^${escapeRe(JSON.parse(p) as string)}$` : stripSlashes(p);
    rest = m[3]!;
    try {
      new RegExp(pattern, "i");
    } catch {
      return bad(`bad regex "${p}"`);
    }
  } else return bad(`not a rule: ${t.slice(0, 40)}`);

  // A quoted literal may itself contain `;` — read it whole before splitting off the format.
  const quoted = /^\s*("(?:[^"\\]|\\.)*")\s*(?:;([\s\S]*))?$/.exec(rest);
  const parts: (string | undefined)[] = quoted ? [quoted[1], quoted[2]] : splitFirst(rest, 2);
  const target = (parts[0] ?? "").trim();
  if (!target) return bad("missing field");
  const rule: MapRule = { kind, line, ...(attr ? { attr } : {}), ...(pattern !== undefined ? { pattern } : {}), ...(xpath ? { xpath } : {}) };
  if (target.toLowerCase() === "button") {
    // An attr rule becomes a "button" rule; an xpath rule keeps kind "xpath" with field "button".
    if (kind === "attr") rule.kind = "button";
    rule.field = "button";
    rule.clicks = Math.max(1, Math.min(10, Number.parseInt((parts[1] ?? "1").trim(), 10) || 1));
    return rule;
  }
  if (/^"(?:[^"\\]|\\.)*"$/.test(target)) rule.literal = JSON.parse(target) as string;
  else if (/^(true|1)$/i.test(target)) rule.bool = true;
  else if (/^(false|0)$/i.test(target)) rule.bool = false;
  else if (FIELD_NAME.test(target)) rule.field = target;
  else return bad(`bad field "${target}"`);
  if (parts[1] !== undefined && parts[1].trim()) rule.format = parts[1].trim();
  return rule;
}

/** Split on the first n semicolons only: a format body may contain `;`. */
function splitFirst(s: string, n: number): string[] {
  const out: string[] = [];
  let rest = s;
  for (let i = 0; i < n - 1; i++) {
    const k = rest.indexOf(";");
    if (k < 0) break;
    out.push(rest.slice(0, k));
    rest = rest.slice(k + 1);
  }
  out.push(rest);
  return out;
}
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const stripSlashes = (p: string) => {
  const m = /^\/(.*)\/[a-z]*$/.exec(p);
  return m ? m[1]! : p;
};

export const SECRET_FIELD = /^(cc[A-Z]\w*|passcode|password|emailCode|smsCode|otherCode)/;
export const isSecretField = (f: string | undefined): boolean => f !== undefined && SECRET_FIELD.test(f);

/** Glob with `*`, case-insensitive, whole URL. */
export function globMatches(glob: string, url: string): boolean {
  // A `*` in the scheme/host part may not cross a `/` — otherwise
  // "https://*.example.com/x*" would match "https://evil.com/?https://a.example.com/x".
  const pathAt = glob.indexOf("/", glob.indexOf("://") + 3);
  const [hostPart, pathPart] = pathAt < 0 ? [glob, ""] : [glob.slice(0, pathAt), glob.slice(pathAt)];
  const conv = (s: string, any: string) => s.split("*").map(escapeRe).join(any);
  if (url.length > 2048 || glob.split("*").length > 7) return false; // bounded: no pathological backtracking
  // A glob without a path ("https://shop.com") also matches "https://shop.com/...".
  return new RegExp(`^${conv(hostPart, "[^/?#@]*")}${pathPart ? conv(pathPart, ".*") : "(/.*)?"}$`, "i").test(url);
}

export interface ResolvedBlock {
  rules: MapRule[];
  human: Set<string>;
  machine: Set<string>;
  traverseShadow: boolean;
  blocks: string[];
}

/** Every block matching the URL (file order), their includes, then `any` unless refused. */
export function resolveBlocks(map: ParsedMap, url: string, builtinAny: MapRule[] = []): ResolvedBlock {
  const byName = new Map(map.blocks.map((b) => [b.name, b]));
  const any = byName.get("any")!;
  const matched = map.blocks.filter((b) => b !== any && globMatches(b.glob, url));
  const res: ResolvedBlock = { rules: [], human: new Set(), machine: new Set(), traverseShadow: false, blocks: [] };
  const seen = new Set<MapBlock>();
  const add = (b: MapBlock, depth: number) => {
    if (seen.has(b) || depth > 8) return;
    seen.add(b);
    res.blocks.push(b.name);
    res.rules.push(...b.rules);
    b.human.forEach((f) => res.human.add(f));
    b.machine.forEach((f) => res.machine.add(f));
    res.traverseShadow ||= b.traverseShadow;
    for (const inc of b.includes) {
      const target = byName.get(inc) ?? map.blocks.find((x) => globMatches(x.glob, inc));
      if (target) add(target, depth + 1);
    }
  };
  matched.forEach((b) => add(b, 0));
  if (!matched.some((b) => b.dontIncludeAny)) {
    add(any, 0);
    res.rules.push(...builtinAny);
  }
  // Secrets (card, codes, passcode, password) are filled only on a URL some
  // block explicitly matched, never by the catch-all `any` block alone.
  if (matched.length === 0) res.rules = res.rules.filter((r) => !isSecretField(r.field));
  return res;
}

/**
 * Today's hint-based fills, as map rules: the built-in `any` block. Card
 * fields are deliberately absent: a card goes only where a map block for
 * that site says so (audit: any URL with a `cardnumber` input got the card).
 */
export const BUILTIN_ANY: MapRule[] = (
  [
    ["email", "email|e-mail"],
    ["firstName", "first.?name|fname|given.?name"],
    ["lastName", "last.?name|lname|family.?name|surname"],
    ["phoneNumber", "phone|mobile|tel"],
    ["address", "address.?(line)?.?1|street"],
    ["address2", "address.?(line)?.?2|apt|suite"],
    ["city", "city|town"],
    ["state", "state|province|region"],
    ["zip", "zip|postal"],
  ] as const
).map(([field, pattern], i) => ({ kind: "attr" as const, attr: "name", pattern, field, line: -1 - i }));

/* ------------------------------ field values ----------------------------- */

export interface FieldSource {
  name: string;
  email: string | null;
  notes?: string | undefined;
  address: { line1?: string | null; line2?: string | null; city?: string | null; state?: string | null; zip?: string | null; country?: string | null } | null;
  phone: string | null;
  sms?: string | null;
  dob: string | null; // YYYY-MM-DD
  card?: { number: string; type?: string | null; cvv?: string | null; expMonth?: string | null; expYear?: string | null; note?: string | null } | null;
  free?: Record<string, string>;
  codes?: Partial<Record<"emailCode" | "smsCode" | "otherCode" | "password", { value: string; timestamp: string | null }>>;
  /** Lazily takes the first unused tab passcode (marks it used). */
  takePasscode?: () => string | null;
}

const STATES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia",
  HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire",
  NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington",
  WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming", DC: "District of Columbia",
};

/** Split a phone into the Jancy variants; returns {} for a phone with fewer than 7 digits. */
function phoneParts(prefix: string, raw: string | null | undefined): Record<string, string> {
  const digits = (raw ?? "").replace(/\D/g, "");
  if (digits.length < 7) return {};
  const cc = digits.length > 10 ? digits.slice(0, digits.length - 10) : "1";
  const nat = digits.slice(-10);
  return {
    [prefix]: raw!,
    [`${prefix}AreaCode`]: nat.slice(0, 3),
    [`${prefix}CountryCode`]: cc,
    [`${prefix}Local`]: nat.slice(3),
    [`${prefix}LocalPrefix`]: nat.slice(3, 6),
    [`${prefix}LocalSuffix`]: nat.slice(6),
    [`${prefix}National`]: `(${nat.slice(0, 3)}) ${nat.slice(3, 6)}-${nat.slice(6)}`,
  };
}

/** Every named profile field Jancy documents (~60) that this profile has a value for. */
export function fieldValues(src: FieldSource, swaps: Record<string, string> = {}): Record<string, string> {
  const sp = src.name.indexOf(" ");
  const a = src.address;
  const v: Record<string, string> = {};
  const put = (k: string, val: string | null | undefined) => {
    if (val !== null && val !== undefined && val !== "") v[k] = val;
  };
  put("firstName", sp > 0 ? src.name.slice(0, sp) : src.name);
  put("lastName", sp > 0 ? src.name.slice(sp + 1).trim() : null);
  put("name", src.name);
  put("email", src.email);
  put("notes", src.notes);
  put("address", a?.line1);
  put("address2", a?.line2);
  put("city", a?.city);
  put("state", a?.state);
  put("stateName", a?.state ? (STATES[a.state.toUpperCase()] ?? a.state) : null);
  put("zip", a?.zip);
  put("country", a?.country);
  if (src.dob && /^\d{4}-\d{2}-\d{2}$/.test(src.dob)) {
    const [y, mo, d] = src.dob.split("-") as [string, string, string];
    put("dob", `${mo}/${d}/${y}`);
    put("dobDay", d);
    put("dobMonth", mo);
    put("dobYear", y);
  }
  Object.assign(v, phoneParts("phoneNumber", src.phone), phoneParts("smsNumber", src.sms));
  const c = src.card;
  if (c) {
    put("ccNumber", c.number.replace(/\s+/g, ""));
    put("ccNumberFormatted", c.number.replace(/\s+/g, "").replace(/(.{4})/g, "$1 ").trim());
    put("ccType", c.type);
    put("ccCVV", c.cvv);
    put("ccExpDateMonth", c.expMonth);
    put("ccExpDateYear", c.expYear);
    if (c.expMonth && c.expYear) put("ccExpDate", `${c.expMonth}/${c.expYear.slice(-2)}`);
    put("ccNote", c.note);
  }
  for (const [k, val] of Object.entries(src.free ?? {})) if (/^free([1-9]|10)$/.test(k)) put(k, val);
  for (const k of ["emailCode", "smsCode", "otherCode", "password"] as const) {
    const r = src.codes?.[k];
    if (r) {
      put(k, r.value);
      put(`${k}Timestamp`, r.timestamp);
    }
  }
  // Swapping: `swap firstName=lastName` makes firstName read lastName's value.
  for (const [to, from] of Object.entries(swaps)) if (v[from] !== undefined) v[to] = v[from]!;
  return v;
}

/* ------------------------------ page script ------------------------------ */

export interface FillConfig {
  rules: MapRule[];
  values: Record<string, string>;
  /** The URL the blocks were matched against; the fill aborts if the page has moved. */
  href: string;
  human: string[];
  machine: string[];
  defaultMode: FillMode;
  fillPopulated: boolean;
  stripCommas: boolean;
  traverseShadow: boolean;
  wpm: number;
}

/** One async Runtime.evaluate; values are JSON-inlined, only field NAMES come back. */
export function buildMapFillExpression(cfg: FillConfig): string {
  return `(async () => {
  const cfg = ${JSON.stringify(cfg)};
  const filled = [], missing = [], errors = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const roots = (root) => {
    const out = [root];
    if (cfg.traverseShadow) for (const el of root.querySelectorAll("*")) if (el.shadowRoot) out.push(...roots(el.shadowRoot));
    return out;
  };
  const all = (sel) => roots(document).flatMap((r) => [...r.querySelectorAll(sel)]);
  const handled = new Set();
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 2 && r.height > 2 && s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.05; };
  const secret = (f) => /^(cc[A-Z]|passcode|password|emailCode|smsCode|otherCode)/.test(f || "");
  const nativeSet = (el, v) => {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const typeInto = async (el, text) => {
    el.focus();
    const base = 60000 / (cfg.wpm * 5);
    let cur = "";
    for (const ch of text) {
      cur += ch;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, cur);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      await sleep(base * (0.65 + Math.random() * 0.7));
    }
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const select = (el, v) => {
    const opts = [...el.options];
    let i = typeof v === "number" ? v : opts.findIndex((o) => o.value.toLowerCase() === String(v).toLowerCase());
    if (i < 0) i = opts.findIndex((o) => o.text.trim().toLowerCase() === String(v).toLowerCase());
    if (i < 0) i = opts.findIndex((o) => o.text.toLowerCase().includes(String(v).toLowerCase()));
    if (i < 0 || !opts[i]) return false;
    nativeSet(el, opts[i].value);
    return true;
  };
  const candidates = (rule) => {
    if (rule.kind === "xpath") {
      const r = document.evaluate(rule.xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      return Array.from({ length: r.snapshotLength }, (_, i) => r.snapshotItem(i));
    }
    const re = new RegExp(rule.pattern, "i");
    const els = rule.kind === "button" ? all("button,input[type=button],input[type=submit],a,[role=button]") : all("input,select,textarea");
    return els.filter((el) => re.test(rule.attr === "text" ? el.textContent || "" : el.getAttribute(rule.attr) ?? el[rule.attr] ?? ""));
  };
  const buttons = [];
  for (const rule of cfg.rules) {
    if (rule.kind === "button" || (rule.kind === "xpath" && rule.field === "button")) { buttons.push(rule); continue; }
    if (location.href !== cfg.href) { errors.push("page changed; fill stopped"); break; }
    const name = rule.field ?? "(literal)";
    let raw = rule.literal !== undefined ? rule.literal : rule.bool !== undefined ? rule.bool : cfg.values[rule.field];
    if (raw === undefined) { if (rule.field && !missing.includes(name)) missing.push(name); continue; }
    let value = raw;
    if (rule.format) {
      try { value = new Function("field", "allFields", rule.format)(raw, cfg.values); }
      catch (e) { errors.push("line " + rule.line + ": " + String(e.message).slice(0, 80)); continue; }
    }
    if (cfg.stripCommas && typeof value === "string") value = value.replace(/,/g, "");
    let did = false;
    for (const el of candidates(rule)) {
      if (handled.has(el) || el.disabled || el.type === "hidden") continue;
      if (secret(rule.field) && !visible(el)) continue;
      const tag = el.tagName;
      if (el.type === "checkbox") { const want = typeof value === "boolean" ? value : /^(true|1)$/i.test(String(value)); if (el.checked !== want) el.click(); }
      else if (el.type === "radio") { if (typeof value === "boolean" ? value : String(el.value).toLowerCase() === String(value).toLowerCase()) el.click(); else continue; }
      else if (tag === "SELECT") { if (!cfg.fillPopulated && el.selectedIndex > 0) continue; if (!select(el, value)) continue; }
      else if (tag === "INPUT" || tag === "TEXTAREA") {
        if (!cfg.fillPopulated && el.value) continue;
        const human = rule.field && (cfg.human.includes(rule.field) || (cfg.defaultMode === "human" && !cfg.machine.includes(rule.field)));
        if (human && tag === "INPUT") await typeInto(el, String(value)); else nativeSet(el, String(value));
      } else continue;
      handled.add(el); did = true; break;
    }
    if (did) { if (rule.field && !filled.includes(name)) filled.push(name); }
    else if (rule.field && !missing.includes(name)) missing.push(name);
  }
  let clicked = 0;
  for (const rule of buttons) {
    if (location.href !== cfg.href) break;
    const el = candidates(rule)[0];
    if (!el) continue;
    for (let i = 0; i < (rule.clicks || 1); i++) { el.click(); clicked++; await sleep(120); }
  }
  return { filled, missing: missing.filter((n) => !filled.includes(n)), clicked, errors };
})()`;
}
