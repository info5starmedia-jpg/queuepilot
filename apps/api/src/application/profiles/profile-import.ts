import { z } from "zod";
import { DomainError, ErrorCodes, type Profile } from "@queuepilot/contracts";
import type { ProfileService } from "./profile.service.js";
import type { ProxyService } from "../proxies/proxy.service.js";

/**
 * P6.1 — bulk profile import from CSV.
 *
 * Columns (header row required, order fixed, extras ignored):
 *   name, proxy, group, tags, notes, platform, timezone, locale
 *
 * - name: required, unique key — re-import UPSERTS by name (update in place).
 * - proxy: empty = direct. Accepted shapes:
 *     host:port
 *     host:port:user:pass
 *     user:pass@host:port
 *     type://any-of-the-above        (type: http | https | socks5)
 *   An existing proxy with the same type/host/port/username is REUSED, so a
 *   re-import never multiplies proxy rows; otherwise a new proxy is created
 *   named after the profile.
 * - tags: "|" separated.
 * - platform: windows | macos | linux (default windows).
 * - timezone/locale: persona coherence hints (IANA names).
 *
 * dryRun validates and reports everything but writes NOTHING — no proxies,
 * no profiles, no identities. A bad row never aborts the file; it is
 * reported and the rest proceeds.
 */

export interface ImportRowError {
  row: number; // 1-based, counting the header as row 1
  name: string;
  message: string;
}

export interface ImportRowResult {
  row: number;
  name: string;
  action: "created" | "updated" | "would-create" | "would-update";
  profileId?: string;
  proxyId?: string | null;
}

export interface ImportReport {
  dryRun: boolean;
  total: number;
  succeeded: number;
  errors: ImportRowError[];
  results: ImportRowResult[];
}

const COLUMNS = [
  "name",
  "proxy",
  "group",
  "tags",
  "notes",
  "platform",
  "timezone",
  "locale",
] as const;

const PlatformEnum = z.enum(["windows", "macos", "linux"]);
const ProxyTypeEnum = z.enum(["http", "https", "socks5"]);

/** Minimal RFC-4180 parser: quotes, escaped quotes, CRLF. No embedded newlines. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
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
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ",") {
      pushField();
      i++;
      continue;
    }
    if (c === "\r") {
      i++;
      continue;
    }
    if (c === "\n") {
      pushRow();
      i++;
      continue;
    }
    field += c;
    i++;
  }
  if (field !== "" || row.length > 0) pushRow();
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

export interface ParsedProxySpec {
  type: "http" | "https" | "socks5";
  host: string;
  port: number;
  username: string | null;
  password: string | null;
}

export function parseProxySpec(raw: string): ParsedProxySpec {
  let s = raw.trim();
  let type: ParsedProxySpec["type"] = "http";
  const scheme = s.match(/^([a-z0-9]+):\/\//i);
  if (scheme) {
    const t = ProxyTypeEnum.safeParse(scheme[1]!.toLowerCase());
    if (!t.success) {
      throw new DomainError(
        ErrorCodes.VALIDATION_FAILED,
        `proxy type "${scheme[1]}" is not one of http|https|socks5`,
      );
    }
    type = t.data;
    s = s.slice(scheme[0].length);
  }
  let username: string | null = null;
  let password: string | null = null;
  const at = s.lastIndexOf("@");
  if (at >= 0) {
    const cred = s.slice(0, at);
    s = s.slice(at + 1);
    const ci = cred.indexOf(":");
    if (ci < 0) throw new DomainError(ErrorCodes.VALIDATION_FAILED, "proxy credentials need user:pass@");
    username = cred.slice(0, ci);
    password = cred.slice(ci + 1);
  }
  const parts = s.split(":");
  if (parts.length < 2 || parts.length > 4) {
    throw new DomainError(
      ErrorCodes.VALIDATION_FAILED,
      `proxy "${raw}" is not host:port[:user:pass]`,
    );
  }
  const [host, portStr, u, p] = parts;
  const port = Number(portStr);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new DomainError(
      ErrorCodes.VALIDATION_FAILED,
      `proxy "${raw}" has a bad host or port`,
    );
  }
  if (username === null && u !== undefined) {
    username = u;
    password = p ?? "";
  }
  return { type, host: host!, port, username, password };
}

export function importProfilesCsv(
  profiles: ProfileService,
  proxies: ProxyService,
  csvText: string,
  opts: { dryRun?: boolean; upsert?: boolean } = {},
): ImportReport {
  const dryRun = opts.dryRun ?? false;
  const upsert = opts.upsert ?? true;
  const rows = parseCsv(csvText);
  const report: ImportReport = { dryRun, total: 0, succeeded: 0, errors: [], results: [] };
  if (rows.length === 0) {
    report.errors.push({ row: 1, name: "", message: "empty file — header row required" });
    return report;
  }
  const header = rows[0]!.map((h) => h.trim().toLowerCase());
  const nameIdx = header.indexOf("name");
  if (nameIdx < 0) {
    report.errors.push({ row: 1, name: "", message: `header must include "name" (got: ${header.join(",")})` });
    return report;
  }
  const col = (r: string[], key: (typeof COLUMNS)[number]): string => {
    const idx = header.indexOf(key);
    return idx >= 0 ? (r[idx] ?? "").trim() : "";
  };

  const existingByName = new Map(profiles.list().map((p) => [p.name, p] as const));
  const existingProxies = proxies.list();

  report.total = rows.length - 1;
  for (let n = 1; n < rows.length; n++) {
    const r = rows[n]!;
    const rowNo = n + 1;
    const fail = (message: string) =>
      report.errors.push({ row: rowNo, name: col(r, "name"), message });
    try {
      const name = col(r, "name");
      if (!name) {
        fail("name is required");
        continue;
      }
      const platformRaw = col(r, "platform");
      const platform = platformRaw
        ? PlatformEnum.parse(platformRaw.toLowerCase())
        : undefined;
      const tags = col(r, "tags")
        ? col(r, "tags").split("|").map((t) => t.trim()).filter(Boolean)
        : undefined;
      const timezone = col(r, "timezone") || undefined;
      const locale = col(r, "locale") || undefined;
      const group = col(r, "group") || undefined;
      const notes = col(r, "notes") || undefined;

      // Resolve the proxy spec first so a bad proxy fails the row before
      // anything else is considered.
      let proxyId: string | null = null;
      const proxySpec = col(r, "proxy");
      let parsedProxy: ParsedProxySpec | null = null;
      if (proxySpec) {
        parsedProxy = parseProxySpec(proxySpec);
        const reuse = existingProxies.find(
          (p) =>
            p.type === parsedProxy!.type &&
            p.host === parsedProxy!.host &&
            p.port === parsedProxy!.port &&
            (p.username ?? null) === parsedProxy!.username,
        );
        if (reuse) proxyId = reuse.id;
      }

      const prior = existingByName.get(name);
      if (prior && !upsert) {
        fail(`a profile named "${name}" already exists (upsert disabled)`);
        continue;
      }
      const action = prior ? "updated" : "created";
      if (dryRun) {
        report.results.push({
          row: rowNo,
          name,
          action: prior ? "would-update" : "would-create",
          proxyId: proxyId ?? (parsedProxy ? "new" : null),
        });
        report.succeeded++;
        continue;
      }

      if (parsedProxy && !proxyId) {
        const created = proxies.create({
          name: `import:${name}`,
          type: parsedProxy.type,
          host: parsedProxy.host,
          port: parsedProxy.port,
          username: parsedProxy.username,
          password: parsedProxy.password,
        });
        proxyId = created.id;
        existingProxies.push(created);
      }

      let profile: Profile;
      if (prior) {
        profile = profiles.update(prior.id, {
          group,
          proxyId,
          notes,
          tags,
        });
      } else {
        profile = profiles.create({
          name,
          group,
          proxyId: proxyId ?? undefined,
          notes,
          tags,
          platform,
          timezone,
          locale,
          generateFingerprint: true,
        });
        existingByName.set(name, profile);
      }
      report.results.push({ row: rowNo, name, action, profileId: profile.id, proxyId });
      report.succeeded++;
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
  }
  return report;
}
