/**
 * Tiny structured logger. Writes one JSON line per event to stderr so stdout stays
 * clean for CLI output and the MCP stdio transport. Redacts credentials.
 */
export type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const REDACT_PATTERNS: Array<[RegExp, string]> = [
  [/(Bearer\s+)[A-Za-z0-9._\-]+/gi, "$1[redacted]"],
  [/("?(?:password|token|refresh_token|pwd|authorization)"?\s*[:=]\s*")[^"]*(")/gi, "$1[redacted]$2"],
  // proxy credentials in host:port:user:pass or user:pass@host
  [/([A-Za-z0-9.-]+:\d{2,5}:)[^:\s]+:[^\s"]+/g, "$1[redacted]:[redacted]"],
  // scheme://user:pass@host — anchored on the scheme because the password may contain "/", where the next pattern stops
  [/((?:socks[45]h?|https?):\/\/[^:@\s/]+:)[^@\s]+@/gi, "$1[redacted]@"],
  [/(\w+):([^@\s/]+)@/g, "$1:[redacted]@"],
  // cloud-phone ADB login code, which execFile errors quote with the whole command line
  [/(glogin\s+)[^\s"]+/g, "$1[redacted]"],
];

export function redact(input: string): string {
  let out = input;
  for (const [re, rep] of REDACT_PATTERNS) out = out.replace(re, rep);
  return out;
}

let minLevel: Level = (process.env["WARMUP_LOG_LEVEL"] as Level | undefined) ?? "info";
export function setLogLevel(l: Level): void {
  minLevel = l;
}

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

function write(level: Level, scope: Record<string, unknown>, msg: string, data?: Record<string, unknown>) {
  if (ORDER[level] < ORDER[minLevel]) return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...scope, ...(data ?? {}) });
  process.stderr.write(redact(line) + "\n");
}

export function createLogger(scope: Record<string, unknown> = {}): Logger {
  return {
    debug: (m, d) => write("debug", scope, m, d),
    info: (m, d) => write("info", scope, m, d),
    warn: (m, d) => write("warn", scope, m, d),
    error: (m, d) => write("error", scope, m, d),
    child: (b) => createLogger({ ...scope, ...b }),
  };
}

export const log = createLogger();
