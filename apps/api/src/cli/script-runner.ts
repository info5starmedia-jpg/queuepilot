import path from "node:path";
import { pathToFileURL } from "node:url";
import { QueuePilotClient, type ApiError } from "@queuepilot/client";
import type { BrowserRun } from "@queuepilot/contracts";

export interface ScriptContext {
  /** Typed API client bound to the running QueuePilot instance. */
  api: QueuePilotClient;
  profileId: string;
  /** The live run (started by the runner if the profile wasn't running). */
  run: BrowserRun;
  /** CDP endpoint for puppeteer.connect / playwright connectOverCDP. */
  wsEndpoint: string;
  debugPort: number;
}

export interface ScriptRunnerDeps {
  apiBase?: string;
  token?: string;
  log?: (message: string) => void;
  /** Test seam: inject a client instead of constructing one from apiBase. */
  client?: QueuePilotClient;
}

/**
 * `queuepilot script <file.mjs> --profile <id> [--url http://127.0.0.1:50325]`
 *
 * Runs a user script against a profile on a RUNNING QueuePilot API. The
 * script is a JS module whose default export receives a ScriptContext; the
 * runner starts the profile's browser if it isn't running (idempotently) and
 * never stops it — scripts borrow the session, they don't own it.
 *
 *   export default async ({ api, wsEndpoint }) => {
 *     const browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint });
 *     ...
 *   };
 */
export async function runScript(
  argv: string[],
  deps: ScriptRunnerDeps = {},
): Promise<number> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const { scriptPath, profileId, url } = parseArgs(argv);
  if (!scriptPath || !profileId) {
    log("usage: queuepilot script <file.mjs> --profile <id> [--url <api-base>]");
    return 2;
  }

  const client =
    deps.client ??
    new QueuePilotClient(deps.apiBase ?? url ?? "http://127.0.0.1:50325", {
      ...(deps.token !== undefined ? { token: deps.token } : {}),
    });

  let mod: { default?: unknown };
  try {
    mod = (await import(pathToFileURL(path.resolve(scriptPath)).href)) as { default?: unknown };
  } catch (err) {
    log(`cannot load script ${scriptPath}: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  if (typeof mod.default !== "function") {
    log(`script ${scriptPath} must have a default export: async (ctx) => { ... }`);
    return 2;
  }

  try {
    const { run } = await client.activeRun(profileId);
    const live = run ?? (await client.start(profileId));
    if (!live.wsEndpoint || !live.debugPort) {
      log("engine returned no ws endpoint");
      return 1;
    }
    const ctx: ScriptContext = {
      api: client,
      profileId,
      run: live,
      wsEndpoint: live.wsEndpoint,
      debugPort: live.debugPort,
    };
    const result: unknown = await (mod.default as (c: ScriptContext) => unknown)(ctx);
    if (result !== undefined) log(JSON.stringify(result, null, 2));
    return 0;
  } catch (err) {
    const e = err as ApiError;
    log(`script failed: ${e.code ? `[${e.code}] ` : ""}${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

function parseArgs(argv: string[]): { scriptPath: string | null; profileId: string | null; url: string | null } {
  const out = { scriptPath: null as string | null, profileId: null as string | null, url: null as string | null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--profile") out.profileId = argv[++i] ?? null;
    else if (arg === "--url") out.url = argv[++i] ?? null;
    else if (!arg.startsWith("-") && !out.scriptPath) out.scriptPath = arg;
  }
  return out;
}
