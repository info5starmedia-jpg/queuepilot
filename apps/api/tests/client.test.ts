import { describe, expect, it } from "vitest";
import { ApiError, QueuePilotClient } from "@queuepilot/client";

/**
 * SDK contract tests: no server involved — a scripted fetcher records every
 * request and answers from a queue, so we assert URL shape, auth header,
 * method/body, and error mapping precisely.
 */
function scriptedFetch(
  answers: Array<{ status: number; body: unknown }>,
): { fetcher: typeof fetch; seen: Array<{ url: string; init: RequestInit }> } {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const fetcher = (async (url: string | URL, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {} });
    const next = answers.shift();
    if (!next) throw new Error("scripted fetch ran out of answers");
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetcher, seen };
}

describe("QueuePilotClient", () => {
  it("sends the bearer token and maps errors to ApiError with stable codes", async () => {
    const { fetcher, seen } = scriptedFetch([
      { status: 409, body: { error: { code: "PROFILE_NOT_RUNNING", message: "no run" } } },
    ]);
    const client = new QueuePilotClient("http://127.0.0.1:50325/", {
      token: "t0ken",
      fetcher,
    });
    const err = await client.attest("p1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(409);
    expect((err as ApiError).code).toBe("PROFILE_NOT_RUNNING");
    expect(seen[0]?.url).toBe("http://127.0.0.1:50325/profiles/p1/attest");
    expect((seen[0]?.init.headers as Record<string, string>).authorization).toBe(
      "Bearer t0ken",
    );
  });

  it("builds filtered list queries", async () => {
    const { fetcher, seen } = scriptedFetch([{ status: 200, body: { profiles: [] } }]);
    const client = new QueuePilotClient("http://127.0.0.1:9", { fetcher });
    await client.listProfiles({ group: "farm", query: "gm" });
    expect(seen[0]?.url).toBe(
      "http://127.0.0.1:9/profiles?group=farm&query=gm",
    );
  });

  it("connect() returns ws endpoint info or throws when the engine gave none", async () => {
    const run = {
      id: "r1",
      profileId: "p1",
      status: "running",
      pid: 1234,
      debugPort: 9222,
      wsEndpoint: "ws://127.0.0.1:9222/devtools/browser/x",
      startedAt: new Date().toISOString(),
      stoppedAt: null,
      lastError: null,
    };
    const ok = scriptedFetch([{ status: 201, body: run }]);
    const client = new QueuePilotClient("http://127.0.0.1:9", { fetcher: ok.fetcher });
    const info = await client.connect("p1");
    expect(info.wsEndpoint).toBe(run.wsEndpoint);
    expect(info.debugPort).toBe(9222);

    const noEndpoint = scriptedFetch([{ status: 201, body: { ...run, wsEndpoint: null } }]);
    const client2 = new QueuePilotClient("http://127.0.0.1:9", {
      fetcher: noEndpoint.fetcher,
    });
    await expect(client2.connect("p1")).rejects.toMatchObject({
      code: "ENGINE_LAUNCH_FAILED",
    });
  });

  it("connectionInfo returns null when nothing is running", async () => {
    const { fetcher } = scriptedFetch([{ status: 200, body: { run: null } }]);
    const client = new QueuePilotClient("http://127.0.0.1:9", { fetcher });
    expect(await client.connectionInfo("p1")).toBeNull();
  });
});
