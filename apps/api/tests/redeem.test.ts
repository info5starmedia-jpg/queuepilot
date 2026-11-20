import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { makeTestContext } from "./helpers.js";
import { redeemInvite } from "../src/application/team/redeem.js";

/** LIC follow-up: redeeming the owner's invite from the console. */
const INVITE = "qpi_" + "a".repeat(30);
let server: http.Server | null = null;
afterEach(() => void server?.close());

function team(handler: (body: { invite?: string }) => { status: number; json: unknown }): Promise<string> {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const r = handler(JSON.parse(raw || "{}"));
        res.writeHead(r.status, { "content-type": "application/json" }).end(JSON.stringify(r.json));
      });
    }).listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server!.address() as { port: number }).port}`));
  });
}

describe("redeem invite", () => {
  it("stores the key in Settings -> Team and never returns it", async () => {
    const url = await team((b) => (b.invite === INVITE ? { status: 201, json: { token: "qpk_" + "z".repeat(30) } } : { status: 401, json: {} }));
    const ctx = makeTestContext();
    const res = await ctx.app.inject({ method: "POST", url: "/team/redeem", payload: { serverUrl: url, invite: INVITE } });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("qpk_");
    expect(res.json()).toEqual({ redeemed: true, serverUrl: url });
    const team_ = (await ctx.app.inject({ method: "GET", url: "/settings/sections/team" })).json();
    expect(team_).toMatchObject({ serverUrl: url, token: "qpk_" + "z".repeat(30) });
    const used = await ctx.app.inject({ method: "POST", url: "/team/redeem", payload: { serverUrl: url, invite: "qpi_" + "b".repeat(30) } });
    expect(used.statusCode).toBe(400);
    expect(used.body).toMatch(/unknown, already used/);
    const cross = await ctx.app.inject({ method: "POST", url: "/team/redeem", payload: { serverUrl: url, invite: INVITE }, headers: { "sec-fetch-site": "cross-site" } });
    expect(cross.statusCode).toBe(403);
  });

  it("refuses plain-http non-loopback servers, credentials in the URL and malformed invites", async () => {
    await expect(redeemInvite("http://example.com", INVITE, undefined)).rejects.toThrow(/https/);
    await expect(redeemInvite("https://u:p@example.com", INVITE, undefined)).rejects.toThrow(/credentials/);
    await expect(redeemInvite("https://example.com", "nope", undefined)).rejects.toThrow(/invite/);
    await expect(redeemInvite("not a url", INVITE, undefined)).rejects.toThrow(/server URL/);
  });
});
