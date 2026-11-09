import { z } from "zod";

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

export const ProfileProviderTypeSchema = z.enum(["csv"]);
export type ProfileProviderType = z.infer<typeof ProfileProviderTypeSchema>;

export const ProfileProviderSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(120),
  type: ProfileProviderTypeSchema,
  /** Absolute path of the CSV file on this machine. */
  sourcePath: z.string().min(1),
  lastRefreshedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ProfileProvider = z.infer<typeof ProfileProviderSchema>;

export const CreateProfileProviderInputSchema = z.object({
  name: z.string().min(1).max(120),
  sourcePath: z.string().min(1),
});
export type CreateProfileProviderInput = z.input<typeof CreateProfileProviderInputSchema>;

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
  smsNumbers: z.array(z.object({ label: z.string(), number: z.string(), countryCode: z.string().nullable() })),
  /** Multiple allowed: "Passcode", "Passcode2", ... (presale / verified-fan). */
  passcodes: z.array(z.string()),
  /** Free 1 … Free 10 arbitrary columns, referenceable by autofill later. */
  free: z.record(z.string()),
  /** Per-profile proxies: "host:port:user:pass", "host:port", or "system connection". */
  proxies: z.array(z.string()),
  notes: z.string().nullable(),
  url: z.string().nullable(),
  timeZone: z.string().nullable(),
  favorite: z.boolean(),
  /** Named credit-card sets: `CC Number:<set>` + `CC CVV:<set>` (+optional fields). */
  creditCards: z.array(
    z.object({
      set: z.string(),
      number: z.string(),
      cvv: z.string(),
      expDate: z.string().nullable(),
      name: z.string().nullable(),
      address: z.string().nullable(),
      address2: z.string().nullable(),
      city: z.string().nullable(),
      state: z.string().nullable(),
      zip: z.string().nullable(),
      note: z.string().nullable(),
    }),
  ),
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

/**
 * Parse a profile-provider CSV. Headers are matched by NAME (case-sensitive),
 * not position. Missing required headers (Profile, Name, Email) fail the
 * whole import; bad rows are reported per-line and skipped.
 */
export function parseProfileCsv(text: string): ProfileCsvParseResult {
  const rows = parseCsv(text);
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

  // Multi-value and prefixed columns.
  const smsCols = headers
    .map((h, idx) => ({ h, idx }))
    .filter(({ h }) => /^SMS Number( \d+(:\d+)?)?$/.test(h));
  const passcodeCols = headers
    .map((h, idx) => ({ h, idx }))
    .filter(({ h }) => /^Passcode\d*$/.test(h));
  const freeCols = headers
    .map((h, idx) => ({ h, idx }))
    .filter(({ h }) => /^Free (?:[1-9]|10)$/.test(h));
  const proxyCols = headers
    .map((h, idx) => ({ h, idx }))
    .filter(({ h }) => /^Proxy( \d+)?$/.test(h));
  const ccCols = headers
    .map((h, idx) => ({ h, idx }))
    .filter(({ h }) => /^CC [A-Za-z ]+:.+$/.test(h));

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
      issues.push({ line, message: "row skipped: Profile, Name and Email are required" });
      continue;
    }

    const smsNumbers = smsCols
      .map(({ h, idx }) => {
        const m = /^SMS Number(?: (\d+))?(?::(\d+))?$/.exec(h)!;
        const label = m[1] ? `SMS Number ${m[1]}` : "SMS Number";
        const value = norm(cells[idx]);
        return value ? { label, number: value, countryCode: m[2] ?? null } : null;
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
        issues.push({ line, message: `card set "${set}" skipped: CC Number:${set} and CC CVV:${set} are required` });
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
      get("Address") || get("Address 2") || get("City") || get("State") || get("Zip Code")
        ? {
            line1: get("Address"),
            line2: get("Address 2"),
            city: get("City"),
            state: get("State"),
            zip: get("Zip Code"),
          }
        : null;

    const parsed = ImportedProfileSchema.safeParse({
      key,
      name,
      email,
      group: get("Group"),
      tabColor: get("Tab Color"),
      address,
      dob: get("DOB"),
      phone: get("Phone Number"),
      smsNumbers,
      passcodes,
      free,
      proxies,
      notes: get("Notes"),
      url: get("URL"),
      timeZone: get("Time Zone"),
      favorite: get("Favorite") === "1",
      creditCards,
    });
    if (!parsed.success) {
      issues.push({ line, message: `row skipped: ${parsed.error.issues[0]?.message ?? "invalid"}` });
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
export const ProxyDistributionSchema = z.enum(["persist", "start-over", "random"]);
export type ProxyDistribution = z.infer<typeof ProxyDistributionSchema>;

export const ProxyProviderSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(120),
  /** "file" = a delimited local file; more source types plug in here later. */
  type: z.enum(["file"]),
  sourcePath: z.string().min(1),
  delimiter: ProxyDelimiterSchema,
  hasHeader: z.boolean(),
  distribution: ProxyDistributionSchema.default("start-over"),
  /** Cursor for start-over/persist distribution; survives restarts. */
  cursor: z.number().int().min(0).default(0),
  lastRefreshedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ProxyProvider = z.infer<typeof ProxyProviderSchema>;

export const CreateProxyProviderInputSchema = z.object({
  name: z.string().min(1).max(120),
  sourcePath: z.string().min(1),
  delimiter: ProxyDelimiterSchema.default(","),
  hasHeader: z.boolean().default(false),
  distribution: ProxyDistributionSchema.default("start-over"),
});
export type CreateProxyProviderInput = z.input<typeof CreateProxyProviderInputSchema>;

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
  const issues: CsvImportIssue[] = [];
  const proxies: ImportedProxy[] = [];
  const lines = text.split(/\r?\n/);
  const start = opts.hasHeader ? 1 : 0;
  for (let i = start; i < lines.length; i++) {
    const raw = lines[i]!;
    if (raw.trim() === "") continue;
    const cells = raw.split(opts.delimiter).map((c) => c.trim());
    if (cells.length < 5) {
      issues.push({ line: i + 1, message: "skipped: expected at least 5 columns (name,host,port,username,password)" });
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
      issues.push({ line: i + 1, message: `skipped: ${parsed.error.issues[0]?.message ?? "invalid"}` });
      continue;
    }
    proxies.push(parsed.data);
  }
  return { proxies, issues };
}
