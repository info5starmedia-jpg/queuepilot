import type { ProxyType } from "@queuepilot/contracts";

/** One importable proxy, parsed from a pasted/uploaded line. */
export interface ParsedProxyLine {
  name: string;
  type: ProxyType;
  host: string;
  port: number;
  username: string | null;
  password: string | null;
  timezone: string | null;
}

export interface ProxyImportResult {
  added: number;
  skipped: number;
  /** 1-based line numbers. Reasons never echo the line: it may carry a password. */
  errors: Array<{ line: number; reason: string }>;
}

const HOST = /^[a-zA-Z0-9._-]+$/;

function isTimezone(s: string): boolean {
  // Area/City only: a bare "UTC" could just as well be a password.
  if (!/^[A-Za-z_]+\/[A-Za-z0-9_+\-/]+$/.test(s)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: s });
    return true;
  } catch {
    return false;
  }
}

/**
 * One line → proxy, or null for a blank/comment line. Accepted:
 *   host:port
 *   host:port:user:pass[:timezone]
 *   name:host:port[:user:pass[:timezone]]      (dashboard's older paste form)
 * with an optional scheme:// prefix that overrides `defaultType`. The
 * password is everything between the user and an optional trailing IANA
 * timezone, so passwords containing ':' survive. Throws with a reason that
 * never contains the line itself.
 */
export function parseProxyLine(raw: string, defaultType: ProxyType): ParsedProxyLine | null {
  let line = raw.trim();
  if (!line || line.startsWith("#")) return null;
  let type: ProxyType = defaultType;
  const scheme = /^([a-z0-9]+):\/\//i.exec(line);
  if (scheme) {
    const s = scheme[1]!.toLowerCase();
    if (s === "http" || s === "https") type = s;
    else if (s === "socks5" || s === "socks5h") type = "socks5";
    else throw new Error(`unsupported scheme "${s}" (http, https, socks5)`);
    line = line.slice(scheme[0].length);
  }
  // user:pass@host:port is the URL form some providers export.
  let creds: string[] = [];
  const at = line.lastIndexOf("@");
  if (at !== -1) {
    creds = line.slice(0, at).split(":");
    line = line.slice(at + 1);
  }
  const parts = line.split(":");
  let name: string | null = null;
  if (parts.length >= 3 && !/^\d+$/.test(parts[1]!) && /^\d+$/.test(parts[2]!)) name = parts.shift()!;
  const [host, port, ...rest] = parts;
  if (!host || host.length > 253 || !HOST.test(host)) throw new Error("invalid host");
  if (!/^\d+$/.test(port ?? "")) throw new Error("expected host:port[:user:pass[:timezone]]");
  const portNum = Number(port);
  if (portNum < 1 || portNum > 65535) throw new Error("port out of range");

  // A trailing IANA zone is the timezone field: host:port:tz, or
  // host:port:user:pass:tz (a lone "user" field never contains '/').
  let timezone: string | null = null;
  if ((rest.length === 1 || rest.length >= 3) && isTimezone(rest[rest.length - 1]!)) timezone = rest.pop()!;
  if (creds.length && rest.length) throw new Error("unexpected fields after port");
  const [username, ...pass] = creds.length ? creds : rest;
  if (username !== undefined && username.length > 200) throw new Error("username too long");
  const password = pass.length ? pass.join(":") : null;
  if (password !== null && password.length > 200) throw new Error("password too long");

  return {
    name: (name || `${host}:${portNum}`).slice(0, 120),
    type,
    host,
    port: portNum,
    username: username || null,
    password: password || null,
    timezone,
  };
}
