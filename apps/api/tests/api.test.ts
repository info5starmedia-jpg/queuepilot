import { describe, expect, it } from "vitest";
import { makeTestContext } from "./helpers.js";

/** End-to-end over the native HTTP surface via fastify.inject (no sockets). */
describe("native API", () => {
  it("health is public", async () => {
    const { app } = makeTestContext();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("ok");
  });

  it("metrics snapshot counts requests and errors (audit finding 3)", async () => {
    const { app } = makeTestContext();
    await app.inject({ method: "GET", url: "/health" });
    await app.inject({ method: "GET", url: "/definitely-missing" });
    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(200);
    const m = res.json();
    // Two requests are counted before this one (the metrics request's own
    // onResponse runs after the handler returns).
    expect(m.requestsTotal).toBeGreaterThanOrEqual(2);
    expect(m.status4xx).toBeGreaterThanOrEqual(1);
    expect(m.logLevel).toBe("silent"); // NODE_ENV=test keeps vitest output clean
  });

  it("creates, reads, updates and deletes a profile", async () => {
    const { app } = makeTestContext();
    const created = await app.inject({
      method: "POST",
      url: "/profiles",
      payload: { name: "api-profile" },
    });
    expect(created.statusCode).toBe(201);
    const profile = created.json();

    const fetched = await app.inject({ method: "GET", url: `/profiles/${profile.id}` });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json().name).toBe("api-profile");

    const updated = await app.inject({
      method: "PATCH",
      url: `/profiles/${profile.id}`,
      payload: { notes: "warmed", tags: ["ticket-drop"] },
    });
    expect(updated.json().notes).toBe("warmed");
    expect(updated.json().tags).toEqual(["ticket-drop"]);

    // v0.14.7: email is a first-class profile field (create + patch + clear).
    const emailed = await app.inject({
      method: "PATCH",
      url: `/profiles/${profile.id}`,
      payload: { email: "warmed@example.com" },
    });
    expect(emailed.statusCode).toBe(200);
    expect(emailed.json().email).toBe("warmed@example.com");
    const cleared = await app.inject({
      method: "PATCH",
      url: `/profiles/${profile.id}`,
      payload: { email: null },
    });
    expect(cleared.json().email).toBeNull();
    const badEmail = await app.inject({
      method: "PATCH",
      url: `/profiles/${profile.id}`,
      payload: { email: "nope" },
    });
    expect(badEmail.statusCode).toBe(400);

    const removed = await app.inject({ method: "DELETE", url: `/profiles/${profile.id}` });
    expect(removed.statusCode).toBe(204);
    const gone = await app.inject({ method: "GET", url: `/profiles/${profile.id}` });
    expect(gone.statusCode).toBe(404);
    expect(gone.json().error.code).toBe("PROFILE_NOT_FOUND");
  });

  it("validates input and reports VALIDATION_FAILED", async () => {
    const { app } = makeTestContext();
    const res = await app.inject({ method: "POST", url: "/profiles", payload: { name: "" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_FAILED");
  });

  it("starts and stops a browser over HTTP", async () => {
    const { app, profiles } = makeTestContext();
    const p = profiles.create({ name: "http-run", generateFingerprint: true });

    const started = await app.inject({ method: "POST", url: `/profiles/${p.id}/start` });
    expect(started.statusCode).toBe(201);
    const run = started.json();
    expect(run.status).toBe("running");

    // Double start over HTTP is a 409 conflict.
    const second = await app.inject({ method: "POST", url: `/profiles/${p.id}/start` });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe("PROFILE_ALREADY_RUNNING");

    const active = await app.inject({ method: "GET", url: `/profiles/${p.id}/run` });
    expect(active.json().run.id).toBe(run.id);

    const stopped = await app.inject({ method: "POST", url: `/profiles/${p.id}/stop` });
    expect(stopped.json().stopped).toBe(true);
  });

  it("regenerates a fingerprint over HTTP", async () => {
    const { app, profiles } = makeTestContext();
    const p = profiles.create({ name: "fp", generateFingerprint: true });
    const res = await app.inject({
      method: "POST",
      url: `/profiles/${p.id}/fingerprint/regenerate`,
      payload: { platform: "macos" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().identityId).not.toBe(p.identityId);
  });
});
