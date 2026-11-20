import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { buildTeamServerApp, type TeamServerApp } from "@queuepilot/server";
import { TeamServerClient } from "../src/application/team/team-client.js";
import { makeTestContext } from "./helpers.js";

/** LIC on the QueuePilot side: the licence status route and the expired-key message. */
describe("team licence (client side)", () => {
  let server: TeamServerApp;
  let base: string;

  beforeEach(async () => {
    server = buildTeamServerApp({ host: "127.0.0.1", port: 0, dbPath: ":memory:", adminToken: "boot", machineName: "t" });
    await server.app.listen({ host: "127.0.0.1", port: 0 });
    base = `http://127.0.0.1:${(server.app.server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await server.close();
  });

  it("reports the account and days left; an expired key surfaces LICENCE_EXPIRED", async () => {
    const acct = server.store.createAccount("tester-1", new Date(Date.now() + 10 * 86_400_000).toISOString());
    const { token } = server.store.mintToken("pc", "operator", acct.id);
    const lic = await new TeamServerClient(base, token).licence();
    expect(lic).toMatchObject({ account: { name: "tester-1" }, role: "operator" });
    expect(lic.daysLeft).toBeGreaterThanOrEqual(9);

    const ctx = makeTestContext();
    expect((await ctx.app.inject({ method: "GET", url: "/team/licence" })).json()).toEqual({ configured: false });

    server.store.updateAccount(acct.id, { expiresAt: new Date(Date.now() - 1000).toISOString() });
    await expect(new TeamServerClient(base, token).licence()).rejects.toMatchObject({ status: 401, code: "LICENCE_EXPIRED" });
  });
});
