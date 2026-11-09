import { describe, expect, it } from "vitest";
import { makeTestContext } from "./helpers.js";

/**
 * AdsPower compatibility contract: the envelope, the field names and the
 * "errors are code!=0, not HTTP status" convention that existing tooling
 * depends on.
 */
describe("AdsPower-compatible Local API", () => {
  it("answers /status in the AdsPower envelope", async () => {
    const { app } = makeTestContext();
    const res = await app.inject({ method: "GET", url: "/status" });
    expect(res.json()).toMatchObject({ code: 0, msg: "success" });
  });

  it("starts a browser via /api/v1/browser/start with AdsPower-shaped data", async () => {
    const { app, profiles } = makeTestContext();
    const p = profiles.create({ name: "ads-run", generateFingerprint: true });
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/browser/start?profile_id=${p.id}`,
    });
    const body = res.json();
    expect(body.code).toBe(0);
    expect(body.data.ws.puppeteer).toContain("ws://");
    expect(body.data.debug_port).toBeTruthy();
  });

  it("reports errors as code=1, never as HTTP errors", async () => {
    const { app } = makeTestContext();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/browser/start?profile_id=3f6b0e62-2c2c-4c2c-9c2c-2c2c2c2c2c2c",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().code).toBe(1);
    expect(res.json().msg).toContain("not found");
  });

  it("stop and active round-trip", async () => {
    const { app, profiles } = makeTestContext();
    const p = profiles.create({ name: "ads-cycle", generateFingerprint: true });
    await app.inject({ method: "GET", url: `/api/v1/browser/start?profile_id=${p.id}` });

    const active = await app.inject({
      method: "GET",
      url: `/api/v1/browser/active?profile_id=${p.id}`,
    });
    expect(active.json().data.status).toBe("Active");

    const stopped = await app.inject({
      method: "POST",
      url: "/api/v1/browser/stop",
      payload: { profile_id: p.id },
    });
    expect(stopped.json().code).toBe(0);

    const inactive = await app.inject({
      method: "GET",
      url: `/api/v1/browser/active?profile_id=${p.id}`,
    });
    expect(inactive.json().data.status).toBe("Inactive");
  });

  it("creates and lists profiles in the AdsPower shape", async () => {
    const { app } = makeTestContext();
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/profile/create",
      payload: { name: "ads-profile" },
    });
    expect(created.json().code).toBe(0);
    const profileId = created.json().data.profile_id;

    const list = await app.inject({ method: "GET", url: "/api/v1/profile/list" });
    const names = list.json().data.list.map((p: { user_id: string }) => p.user_id);
    expect(names).toContain(profileId);
  });
});
