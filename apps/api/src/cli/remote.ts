import fs from "node:fs";

/**
 * P6.4 — remote CLI over the local API. The server is the single source of
 * truth; the CLI is a thin, scriptable client (exit codes + --json, never
 * scraped text).
 *
 *   queuepilot profiles list [--group g] [--query q] [--json]
 *   queuepilot profiles import <file.csv> [--dry-run] [--no-upsert] [--json]
 *   queuepilot profile start|stop <name-or-id> [--json]
 *   queuepilot profile run <name-or-id> [--json]      (current run state)
 *
 * Connection: SPECTRA_API_URL (default http://127.0.0.1:50325),
 * SPECTRA_API_TOKEN when the server sets one.
 */

export interface RemoteCliDeps {
  baseUrl?: string;
  token?: string;
  log?: (message: string) => void;
  err?: (message: string) => void;
  fetchImpl?: typeof fetch;
}

interface Flags {
  _: string[];
  json: boolean;
  group?: string | undefined;
  query?: string | undefined;
  dryRun: boolean;
  upsert: boolean;
}

export function parseRemoteFlags(argv: string[]): Flags {
  const f: Flags = { _: [], json: false, dryRun: false, upsert: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--json") f.json = true;
    else if (a === "--dry-run") f.dryRun = true;
    else if (a === "--no-upsert") f.upsert = false;
    else if (a === "--group") f.group = argv[++i];
    else if (a === "--query") f.query = argv[++i];
    else f._.push(a);
  }
  return f;
}

async function call(
  deps: Required<Pick<RemoteCliDeps, "fetchImpl">> & RemoteCliDeps,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: unknown }> {
  const base = deps.baseUrl ?? process.env.SPECTRA_API_URL ?? "http://127.0.0.1:50325";
  const token = deps.token ?? process.env.SPECTRA_API_TOKEN;
  // A POST with content-type: application/json must carry a body (fastify
  // 500s on an empty one) — send {} when the caller has none.
  const payload = body ?? (method === "POST" ? {} : undefined);
  const res = await deps.fetchImpl(`${base}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    } as Record<string, string>,
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  return { status: res.status, data };
}

const USAGE = `usage:
  queuepilot profiles list [--group g] [--query q] [--json]
  queuepilot profiles import <file.csv> [--dry-run] [--no-upsert] [--json]
  queuepilot profile start|stop|run <name-or-id> [--json]`;

export async function runRemoteCli(
  argv: string[],
  deps: RemoteCliDeps = {},
): Promise<number> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const err = deps.err ?? ((m: string) => console.error(m));
  const fetchImpl = deps.fetchImpl ?? fetch;
  const d = { ...deps, fetchImpl };
  const flags = parseRemoteFlags(argv);
  const [noun, action, ...rest] = flags._;

  const emit = (data: unknown, pretty: (x: never) => string) => {
    if (flags.json) log(JSON.stringify(data));
    else log(pretty(data as never));
  };

  try {
    if (noun === "profiles" && action === "list") {
      const qs = new URLSearchParams();
      if (flags.group) qs.set("group", flags.group);
      if (flags.query) qs.set("query", flags.query);
      const { status, data } = await call(d, "GET", `/profiles?${qs}`);
      if (status !== 200) return fail(err, status, data);
      emit(data, (x: { profiles: { name: string; status: string; group: string; proxyId: string | null }[] }) =>
        x.profiles.map((p) => `${p.name}\t${p.group}\t${p.status}\t${p.proxyId ?? "direct"}`).join("\n") || "(no profiles)");
      return 0;
    }

    if (noun === "profiles" && action === "import") {
      const file = rest[0];
      if (!file) {
        err("profiles import needs a CSV file path");
        return 2;
      }
      const csv = fs.readFileSync(file, "utf8");
      const { status, data } = await call(d, "POST", "/profiles/import", {
        csv,
        dryRun: flags.dryRun,
        upsert: flags.upsert,
      });
      if (status !== 200) return fail(err, status, data);
      emit(data, (r: { dryRun?: boolean; total: number; succeeded: number; errors: { row: number; name: string; message: string }[]; results: { name: string; action: string }[] }) =>
        [
          `${r.succeeded}/${r.total} rows ok${r.dryRun ? " (dry run — nothing written)" : ""}`,
          ...r.results.map((x) => `  ${x.action}\t${x.name}`),
          ...r.errors.map((e) => `  ERROR row ${e.row} (${e.name}): ${e.message}`),
        ].join("\n"));
      const r = data as { errors: unknown[] };
      return r.errors.length ? 1 : 0;
    }

    if (noun === "profile" && ["start", "stop", "run"].includes(action ?? "")) {
      const id = await resolveProfileId(d, rest[0]);
      if (!id) {
        err(`profile "${rest[0]}" not found (name or id expected)`);
        return 2;
      }
      const path = action === "run" ? `/profiles/${id}/run` : `/profiles/${id}/${action}`;
      const { status, data } = await call(d, action === "run" ? "GET" : "POST", path);
      if (status >= 400) return fail(err, status, data);
      emit(data, (x: unknown) => JSON.stringify(x, null, 2));
      return 0;
    }

    err(USAGE);
    return 2;
  } catch (e) {
    err(
      `cannot reach the API: ${e instanceof Error ? e.message : String(e)}\n` +
        `is the server running? (SPECTRA_API_URL, default http://127.0.0.1:50325)`,
    );
    return 3;
  }
}

async function resolveProfileId(
  d: RemoteCliDeps & Required<Pick<RemoteCliDeps, "fetchImpl">>,
  nameOrId: string | undefined,
): Promise<string | null> {
  if (!nameOrId) return null;
  if (/^[0-9a-f-]{36}$/i.test(nameOrId)) return nameOrId;
  const { status, data } = await call(d, "GET", "/profiles");
  if (status !== 200) return null;
  const profiles = (data as { profiles: { id: string; name: string }[] }).profiles;
  return profiles.find((p) => p.name === nameOrId)?.id ?? null;
}

function fail(err: (m: string) => void, status: number, data: unknown): number {
  err(`API ${status}: ${JSON.stringify(data)}`);
  return 1;
}
