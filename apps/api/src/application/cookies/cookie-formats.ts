import { DomainError, ErrorCodes } from "@queuepilot/contracts";
import type { CookieRecord } from "./cookie-thinger.js";

/**
 * Standard cookie file formats (v0.15.1, audit G1/Jancy gap): import and
 * export the standard interchange shapes instead of only the encrypted
 * bundle + live-CDP paths.
 *
 * - Netscape: the `cookies.txt` Mozilla/Netscape format every tool speaks —
 *   tab-separated lines, `#HttpOnly_` prefix convention, epoch seconds.
 * - JSON: Playwright/Chrome-export-compatible array of objects with the
 *   same fields the CDP cookie record carries.
 */

export type CookieFileFormat = "netscape" | "json";

const NETSCAPE_LINE = /^([^\t]+)\t([^\t]+)\t([^\t]+)\t([^\t]+)\t([^\t]+)\t([^\t]+)\t([^\t]+)$/;
const NETSCAPE_PREFIX = "# Netscape HTTP Cookie File";

/** Parse a Netscape/Mozilla cookies.txt document into cookie records. */
export function parseNetscapeCookies(text: string): CookieRecord[] {
  const out: CookieRecord[] = [];
  const lines = text.split(/\r?\n/);
  for (const [i, raw] of lines.entries()) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") && !line.startsWith("#HttpOnly_")) continue;
    let httpOnly = false;
    let body = line;
    if (line.startsWith("#HttpOnly_")) {
      httpOnly = true;
      body = line.slice("#HttpOnly_".length);
    }
    const m = NETSCAPE_LINE.exec(body);
    if (!m) {
      throw new DomainError(ErrorCodes.VALIDATION_FAILED, 
        `netscape cookie line ${i + 1} is not tab-separated: ${JSON.stringify(raw.slice(0, 80))}`,
      );
    }
    const [, domain, flag, path, secure, expires, name, value] = m;
    const expiresNum = Number(expires);
    if (!Number.isFinite(expiresNum) || expiresNum < 0) {
      throw new DomainError(ErrorCodes.VALIDATION_FAILED, `netscape cookie line ${i + 1} has a bad expires value: ${expires}`);
    }
    out.push({
      name: name!,
      value: value!,
      domain: domain!,
      path: path! || "/",
      expires: expiresNum,
      secure: secure === "TRUE",
      httpOnly,
      browserContextId: null,
    });
  }
  return out;
}

/** Serialize records to a Netscape cookies.txt document. */
export function serializeNetscapeCookies(cookies: CookieRecord[]): string {
  const lines = [NETSCAPE_PREFIX, "# https://curl.se/docs/http-cookies.html"];
  for (const c of cookies) {
    lines.push(
      [
        c.httpOnly ? `#HttpOnly_${c.domain}` : c.domain,
        "TRUE", // include subdomains — the leading dot already encodes scope
        c.path || "/",
        c.secure ? "TRUE" : "FALSE",
        String(Math.max(0, Math.trunc(c.expires))),
        c.name,
        c.value,
      ].join("\t"),
    );
  }
  return lines.join("\n") + "\n";
}

interface JsonCookie {
  name?: unknown;
  value?: unknown;
  domain?: unknown;
  path?: unknown;
  expires?: unknown;
  secure?: unknown;
  httpOnly?: unknown;
}

/** Parse a JSON cookie export (array of objects) into cookie records. */
export function parseJsonCookies(text: string): CookieRecord[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new DomainError(ErrorCodes.VALIDATION_FAILED, 
      `cookie JSON does not parse: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!Array.isArray(raw)) {
    throw new DomainError(ErrorCodes.VALIDATION_FAILED, "cookie JSON must be an array of cookie objects");
  }
  return raw.map((item, i) => {
    const c = (item ?? {}) as JsonCookie;
    if (typeof c.name !== "string" || c.name === "") {
      throw new DomainError(ErrorCodes.VALIDATION_FAILED, `cookie JSON entry ${i + 1} is missing a name`);
    }
    if (typeof c.value !== "string") {
      throw new DomainError(ErrorCodes.VALIDATION_FAILED, `cookie JSON entry ${i + 1} (${c.name}) is missing a string value`);
    }
    if (typeof c.domain !== "string" || c.domain === "") {
      throw new DomainError(ErrorCodes.VALIDATION_FAILED, `cookie JSON entry ${i + 1} (${c.name}) is missing a domain`);
    }
    const expires = c.expires === undefined || c.expires === null ? 0 : Number(c.expires);
    if (!Number.isFinite(expires) || expires < 0) {
      throw new DomainError(ErrorCodes.VALIDATION_FAILED, `cookie JSON entry ${i + 1} (${c.name}) has a bad expires value`);
    }
    return {
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: typeof c.path === "string" && c.path ? c.path : "/",
      expires,
      secure: c.secure === true,
      httpOnly: c.httpOnly === true,
      browserContextId: null,
    };
  });
}

/** Serialize records to the JSON interchange shape (pretty-printed). */
export function serializeJsonCookies(cookies: CookieRecord[]): string {
  return JSON.stringify(
    cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || "/",
      expires: Math.max(0, Math.trunc(c.expires)),
      secure: c.secure,
      httpOnly: c.httpOnly,
    })),
    null,
    2,
  );
}

export function parseCookies(format: CookieFileFormat, text: string): CookieRecord[] {
  return format === "netscape" ? parseNetscapeCookies(text) : parseJsonCookies(text);
}

export function serializeCookies(
  format: CookieFileFormat,
  cookies: CookieRecord[],
): string {
  return format === "netscape" ? serializeNetscapeCookies(cookies) : serializeJsonCookies(cookies);
}
