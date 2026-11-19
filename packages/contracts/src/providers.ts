import { z } from "zod";
import { PersonaCreditCardSchema } from "./profile.js";

/**
 * Profile-provider contracts.
 *
 * A profile provider is a refreshable external source of profiles. First
 * source: CSV files following the column conventions operators already use —
 * required headers `Profile`, `Name`, `Email` (case-sensitive, matched by
 * name, not position), plus a large optional-column spec (address, DOB,
 * phone, SMS numbers, passcodes, free columns, per-profile proxies, credit
 * card sets, notes, URL, timezone, favorite).
 *
 * Import semantics: a row is keyed by (providerId, Profile-column value).
 * Refreshing a provider upserts rows — existing profiles keep their identity
 * and run state, only the data fields move.
 */

export const ProfileProviderTypeSchema = z.enum(["csv", "googleSheet"]);
export type ProfileProviderType = z.infer<typeof ProfileProviderTypeSchema>;

export const ProfileProviderSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(120),
  type: ProfileProviderTypeSchema,
  /** Absolute path of the CSV file on this machine (type=csv). */
  sourcePath: z.string().min(1).nullable().default(null),
  /** Google Sheet id (type=googleSheet). */
  sheetId: z.string().min(1).nullable().default(null),
  /** A1 range within the sheet; defaults to the first sheet's used range. */
  sheetRange: z.string().min(1).nullable().default(null),
  lastRefreshedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ProfileProvider = z.infer<typeof ProfileProviderSchema>;

/** Exactly one source: a local CSV path or a Google Sheet id. */
export const CreateProfileProviderInputSchema = z
  .object({
    name: z.string().min(1).max(120),
    sourcePath: z.string().min(1).optional(),
    sheetId: z.string().min(1).optional(),
    sheetRange: z.string().min(1).optional(),
  })
  .refine((v) => (v.sourcePath ? !v.sheetId : !!v.sheetId), {
    message:
      "provide exactly one of sourcePath (CSV) or sheetId (Google Sheet)",
  });
export type CreateProfileProviderInput = z.input<
  typeof CreateProfileProviderInputSchema
>;

/** One parsed CSV row, keyed by the required `Profile` column. */
export const ImportedProfileSchema = z.object({
  /** Value of the required `Profile` column — the stable import key. */
  key: z.string().min(1),
  name: z.string().min(1),
  email: z.string().min(1),
  group: z.string().nullable(),
  tabColor: z.string().nullable(),
  address: z
    .object({
      line1: z.string().nullable(),
      line2: z.string().nullable(),
      city: z.string().nullable(),
      state: z.string().nullable(),
      zip: z.string().nullable(),
    })
    .nullable(),
  dob: z.string().nullable(),
  phone: z.string().nullable(),
  /** Multiple allowed: "SMS Number", "SMS Number 2", "SMS Number 3:44" (+44). */
  smsNumbers: z.array(
    z.object({
      label: z.string(),
      number: z.string(),
      countryCode: z.string().nullable(),
    }),
  ),
  /** Multiple allowed: "Passcode", "Passcode2", ... (presale / verified-fan). */
  passcodes: z.array(z.string()),
  /**
   * TOTP seed (base32, as printed by authenticator apps). A SECRET: import
   * stores it in the SecretStore keyed by the profile's identity, never in
   * the profile row or extra bag.
   */
  totp: z.string().nullable(),
  /** Free 1 … Free 10 arbitrary columns, referenceable by autofill later. */
  free: z.record(z.string()),
  /** Per-profile proxies: "host:port:user:pass", "host:port", or "system connection". */
  proxies: z.array(z.string()),
  notes: z.string().nullable(),
  url: z.string().nullable(),
  timeZone: z.string().nullable(),
  favorite: z.boolean(),
  /** Named credit-card sets: `CC Number:<set>` + `CC CVV:<set>` (+optional fields). */
  creditCards: z.array(PersonaCreditCardSchema),
  /**
   * Jancy `Site:<x>` columns, keyed by the header text after `Site:`
   * (`Ticketmaster`, `AXS`, `MLB`, `somesite.com; other.com`, `*`), in FILE
   * ORDER — Jancy evaluates custom columns in column order, so `*` must stay
   * last. Values are the raw resolver cells (`password=$x, emailcode=…`).
   */
  sites: z.record(z.string()).default({}),
  /** `Persist Cookies` / `Persist Sessions`: 1 → true, 0 → false, anything else → null (follow the global setting). */
  persistCookies: z.boolean().nullable().default(null),
  persistSessions: z.boolean().nullable().default(null),
  /** `Buyer`: comma-separated buyer ids allowed to use this profile. */
  buyers: z.array(z.string()).default([]),
  /** `Proxy Resolver`: a resolver spec that fetches this profile's proxy (tried before `Proxy`). */
  proxyResolver: z.string().nullable().default(null),
});
export type ImportedProfile = z.infer<typeof ImportedProfileSchema>;

export interface CsvImportIssue {
  line: number;
  message: string;
}

export interface ProfileCsvParseResult {
  profiles: ImportedProfile[];
  issues: CsvImportIssue[];
}

/** Minimal RFC-4180 CSV reader: quoted fields, embedded commas/newlines/quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let i = 0;
  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ",") {
      pushField();
      i++;
      continue;
    }
    if (ch === "\r") {
      i++;
      continue;
    }
    if (ch === "\n") {
      pushRow();
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  // Last row (only if it has any content).
  if (field.length > 0 || row.length > 0) pushRow();
  return rows.filter((r) => !(r.length === 1 && r[0]!.trim() === ""));
}

const norm = (s: string | undefined): string | null => {
  const v = (s ?? "").trim();
  return v === "" ? null : v;
};

/* Jancy profile-CSV header grammar (docs.jancy.io/docs/optional-columns). */
const SITE_HEADER = /^Site\s*:\s*(.+)$/;
const SMS_HEADER = /^SMS Number/;
/** `Proxy`, `Proxy 2`, `Proxy backup`, … — but not `Proxy Resolver`. */
const PROXY_HEADER = /^Proxy(?! Resolver$)/;
const KNOWN_PROFILE_HEADERS = new Set([
  "Profile", "Name", "Email", "Group", "Tab Color",
  "Address", "Address 2", "City", "State", "Zip Code",
  "DOB", "Phone Number", "TOTP", "Notes", "URL", "Time Zone", "Favorite",
  "Persist Cookies", "Persist Sessions", "Buyer", "Proxy Resolver",
]);

/** Jancy: `1` → on, `0` → off, anything else → follow the global setting. */
function zeroOne(v: string | null): boolean | null {
  return v === "1" ? true : v === "0" ? false : null;
}

/** Jancy strips a leading US country code: `11112223333` → `1112223333`. */
function normalizePhone(v: string | null): string | null {
  if (!v) return v;
  const digits = v.replace(/\D/g, "");
  return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : v;
}

/**
 * One `SMS Number…` cell. The country code (Jancy supports 1 and 44) may sit
 * in the header after a colon (`SMS Number 3:44`) — header wins — or in the
 * cell itself (`19998887777`, `447700900123`).
 */
function parseSmsCell(
  header: string,
  value: string,
): { label: string; number: string; countryCode: string | null } {
  const colon = header.lastIndexOf(":");
  const tail = colon > 0 ? header.slice(colon + 1).trim() : "";
  const headerCc = /^\d+$/.test(tail) ? tail : null;
  const label = (headerCc ? header.slice(0, colon) : header).trim();
  if (headerCc) return { label, number: value, countryCode: headerCc };
  const digits = value.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) {
    return { label, number: digits.slice(1), countryCode: "1" };
  }
  if (digits.length === 12 && digits.startsWith("44")) {
    return { label, number: digits.slice(2), countryCode: "44" };
  }
  return { label, number: value, countryCode: null };
}

/**
 * Parse a profile-provider CSV. Headers are matched by NAME (case-sensitive),
 * not position. Missing required headers (Profile, Name, Email) fail the
 * whole import; bad rows are reported per-line and skipped.
 */
export function parseProfileCsv(text: string): ProfileCsvParseResult {
  return parseProfileRows(parseCsv(text));
}

/**
 * The row-level core of profile imports, shared by CSV files and Google
 * Sheets (whose API already returns string[][]). Row 1 is headers.
 */
export function parseProfileRows(rows: string[][]): ProfileCsvParseResult {
  const issues: CsvImportIssue[] = [];
  if (rows.length === 0) {
    return { profiles: [], issues: [{ line: 1, message: "file is empty" }] };
  }
  const headers = rows[0]!.map((h) => h.trim());
  const col = new Map<string, number>();
  headers.forEach((h, idx) => {
    if (!col.has(h)) col.set(h, idx);
  });
  for (const required of ["Profile", "Name", "Email"]) {
    if (!col.has(required)) {
      return {
        profiles: [],
        issues: [{ line: 1, message: `missing required column: ${required}` }],
      };
    }
  }

  // Multi-value and prefixed columns. Jancy lets the text after `SMS Number`,
  // `Passcode` and `Proxy` be anything ("change the text following…"); the
  // order is left-to-right column order.
  const indexed = headers.map((h, idx) => ({ h, idx }));
  const smsCols = indexed.filter(({ h }) => SMS_HEADER.test(h));
  const passcodeCols = indexed.filter(({ h }) => /^Passcode/.test(h));
  const freeCols = indexed.filter(({ h }) => /^Free (?:[1-9]|10)$/.test(h));
  const proxyCols = indexed.filter(({ h }) => PROXY_HEADER.test(h));
  const ccCols = indexed.filter(({ h }) => /^CC [A-Za-z ]+:.+$/.test(h));
  const siteCols = indexed
    .map(({ idx, h }) => ({ idx, key: SITE_HEADER.exec(h)?.[1]?.trim() ?? "" }))
    .filter(({ key }) => key !== "");

  // Jancy silently ignores a header it doesn't know (case-sensitive), which
  // is how a typo'd `site:Ticketmaster` loses a whole 2FA setup. Say so.
  for (const h of headers) {
    if (h === "" || KNOWN_PROFILE_HEADERS.has(h)) continue;
    if (
      SMS_HEADER.test(h) ||
      /^Passcode/.test(h) ||
      /^Free (?:[1-9]|10)$/.test(h) ||
      PROXY_HEADER.test(h) ||
      /^CC [A-Za-z ]+:.+$/.test(h) ||
      SITE_HEADER.test(h)
    ) {
      continue;
    }
    issues.push({ line: 1, message: `unknown column "${h}" ignored (headers are case-sensitive)` });
  }

  const profiles: ImportedProfile[] = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r]!;
    const get = (h: string): string | null => {
      const idx = col.get(h);
      return idx === undefined ? null : norm(cells[idx]);
    };
    const line = r + 1;
    const key = get("Profile");
    const name = get("Name");
    const email = get("Email");
    if (!key || !name || !email) {
      issues.push({
        line,
        message: "row skipped: Profile, Name and Email are required",
      });
      continue;
    }

    const smsNumbers = smsCols
      .map(({ h, idx }) => {
        const value = norm(cells[idx]);
        return value ? parseSmsCell(h, value) : null;
      })
      .filter((v): v is NonNullable<typeof v> => v !== null);

    const passcodes = passcodeCols
      .map(({ idx }) => norm(cells[idx]))
      .filter((v): v is string => v !== null);

    const free: Record<string, string> = {};
    for (const { h, idx } of freeCols) {
      const v = norm(cells[idx]);
      if (v) free[h] = v;
    }

    const proxies = proxyCols
      .map(({ idx }) => norm(cells[idx]))
      .filter((v): v is string => v !== null);

    // Credit cards: group CC columns by their :<set> suffix.
    const cardSets = new Map<string, Record<string, string>>();
    for (const { h, idx } of ccCols) {
      const m = /^CC ([A-Za-z ]+):(.+)$/.exec(h)!;
      const fieldName = m[1]!.trim();
      const setName = m[2]!.trim();
      const v = norm(cells[idx]);
      if (!v) continue;
      if (!cardSets.has(setName)) cardSets.set(setName, {});
      cardSets.get(setName)![fieldName] = v;
    }
    const creditCards: ImportedProfile["creditCards"] = [];
    for (const [set, fields] of cardSets) {
      if (!fields["Number"] || !fields["CVV"]) {
        issues.push({
          line,
          message: `card set "${set}" skipped: CC Number:${set} and CC CVV:${set} are required`,
        });
        continue;
      }
      creditCards.push({
        set,
        number: fields["Number"],
        cvv: fields["CVV"],
        expDate: fields["Exp Date"] ?? null,
        name: fields["Name"] ?? null,
        address: fields["Address"] ?? null,
        address2: fields["Address2"] ?? null,
        city: fields["City"] ?? null,
        state: fields["State"] ?? null,
        zip: fields["Zip"] ?? null,
        note: fields["Note"] ?? null,
      });
    }

    const address =
      get("Address") ||
      get("Address 2") ||
      get("City") ||
      get("State") ||
      get("Zip Code")
        ? {
            line1: get("Address"),
            line2: get("Address 2"),
            city: get("City"),
            state: get("State"),
            zip: get("Zip Code"),
          }
        : null;

    const sites: Record<string, string> = {};
    for (const { idx, key: siteKey } of siteCols) {
      const v = norm(cells[idx]);
      if (v) sites[siteKey] = v;
    }

    const parsed = ImportedProfileSchema.safeParse({
      key,
      name,
      email,
      group: get("Group"),
      tabColor: get("Tab Color"),
      address,
      dob: get("DOB"),
      phone: normalizePhone(get("Phone Number")),
      sites,
      persistCookies: zeroOne(get("Persist Cookies")),
      persistSessions: zeroOne(get("Persist Sessions")),
      buyers: (get("Buyer") ?? "")
        .split(",")
        .map((b) => b.trim())
        .filter(Boolean),
      proxyResolver: get("Proxy Resolver"),
      smsNumbers,
      passcodes,
      totp: get("TOTP"),
      free,
      proxies,
      notes: get("Notes"),
      url: get("URL"),
      timeZone: get("Time Zone"),
      favorite: get("Favorite") === "1",
      creditCards,
    });
    if (!parsed.success) {
      issues.push({
        line,
        message: `row skipped: ${parsed.error.issues[0]?.message ?? "invalid"}`,
      });
      continue;
    }
    profiles.push(parsed.data);
  }
  return { profiles, issues };
}

/* ------------------------------------------------------------------ */
/* Proxy providers                                                     */
/* ------------------------------------------------------------------ */

export const ProxyDelimiterSchema = z.enum([",", "\t", ":", ";"]);
export type ProxyDelimiter = z.infer<typeof ProxyDelimiterSchema>;

/** How a provider hands out proxies at assignment time. */
export const ProxyDistributionSchema = z.enum([
  "persist",
  "start-over",
  "random",
]);
export type ProxyDistribution = z.infer<typeof ProxyDistributionSchema>;

export const ProxyProviderSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(120),
  /** "file" = a delimited local file; "googleSheet" = a Google Sheet. */
  type: z.enum(["file", "googleSheet"]),
  sourcePath: z.string().min(1).nullable().default(null),
  sheetId: z.string().min(1).nullable().default(null),
  sheetRange: z.string().min(1).nullable().default(null),
  delimiter: ProxyDelimiterSchema,
  hasHeader: z.boolean(),
  distribution: ProxyDistributionSchema.default("start-over"),
  /** Cursor for start-over/persist distribution; survives restarts. */
  cursor: z.number().int().min(0).default(0),
  /** Jancy star: marks the default provider (console pin + CLI picker). */
  starred: z.boolean().default(false),
  lastRefreshedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ProxyProvider = z.infer<typeof ProxyProviderSchema>;

export const CreateProxyProviderInputSchema = z
  .object({
    name: z.string().min(1).max(120),
    sourcePath: z.string().min(1).optional(),
    sheetId: z.string().min(1).optional(),
    sheetRange: z.string().min(1).optional(),
    delimiter: ProxyDelimiterSchema.default(","),
    hasHeader: z.boolean().default(false),
    distribution: ProxyDistributionSchema.default("start-over"),
  })
  .refine((v) => (v.sourcePath ? !v.sheetId : !!v.sheetId), {
    message:
      "provide exactly one of sourcePath (file) or sheetId (Google Sheet)",
  });
export type CreateProxyProviderInput = z.input<
  typeof CreateProxyProviderInputSchema
>;

/** One parsed proxy line. Column order: name,host,port,username,password[,timezone]. */
export const ImportedProxySchema = z.object({
  name: z.string().min(1),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  username: z.string().nullable(),
  password: z.string().nullable(),
  /** Optional 6th column — applied to the tab/profile when the proxy is used. */
  timezone: z.string().nullable(),
});
export type ImportedProxy = z.infer<typeof ImportedProxySchema>;

export interface ProxyFileParseResult {
  proxies: ImportedProxy[];
  issues: CsvImportIssue[];
}

/**
 * Parse a delimited proxy file. Column order is fixed
 * (name,host,port,username,password[,timezone]); the delimiter and whether a
 * header row exists are provider settings. Blank lines are ignored; bad lines
 * are reported, not fatal.
 */
export function parseProxyFile(
  text: string,
  opts: { delimiter: ProxyDelimiter; hasHeader: boolean },
): ProxyFileParseResult {
  const rows = text
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "")
    .map((l) => l.split(opts.delimiter).map((c) => c.trim()));
  return parseProxyRows(rows, opts);
}

/**
 * The row-level core of proxy imports, shared by delimited files and Google
 * Sheets. Column order is fixed (name,host,port,username,password[,timezone]).
 */
export function parseProxyRows(
  rows: string[][],
  opts: { hasHeader: boolean },
): ProxyFileParseResult {
  const issues: CsvImportIssue[] = [];
  const proxies: ImportedProxy[] = [];
  const start = opts.hasHeader ? 1 : 0;
  for (let i = start; i < rows.length; i++) {
    const cells = rows[i]!;
    if (cells.every((c) => c.trim() === "")) continue;
    const line = i + 1;
    if (cells.length < 5) {
      issues.push({
        line,
        message:
          "skipped: expected at least 5 columns (name,host,port,username,password)",
      });
      continue;
    }
    const port = Number(cells[2]);
    const parsed = ImportedProxySchema.safeParse({
      name: cells[0],
      host: cells[1],
      port,
      username: norm(cells[3]),
      password: norm(cells[4]),
      timezone: norm(cells[5]),
    });
    if (!parsed.success) {
      issues.push({
        line,
        message: `skipped: ${parsed.error.issues[0]?.message ?? "invalid"}`,
      });
      continue;
    }
    proxies.push(parsed.data);
  }
  return { proxies, issues };
}
