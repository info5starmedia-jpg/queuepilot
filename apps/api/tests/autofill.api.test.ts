import { describe, expect, it, afterEach } from "vitest";
import { makeTestContext, type TestContext } from "./helpers.js";
import { FakeBrowserRuntime } from "../src/application/runtime/fake.browser-runtime.js";
import { MockCdpServer } from "./helpers/mock-cdp-server.js";

/**
 * v0.14.4 credit-card autofill: POST /profiles/:id/autofill/card pushes the
 * named card set into the checkout page over CDP. Values travel INTO the
 * page only; the response names filled fields, never values.
 */

const CARD = {
  set: "personal",
  number: "4242424242424242",
  cvv: "123",
  expDate: "12/28",
  name: "J Doe",
  address: "1 Main St",
  address2: null,
  city: "Toronto",
  state: "ON",
  zip: "M5V",
  note: null,
};

let ctx: TestContext;
let mock: MockCdpServer;
let runtime: FakeBrowserRuntime;

async function boot() {
  runtime = new FakeBrowserRuntime();
  mock = new MockCdpServer();
  const { wsUrl } = await mock.start();
  runtime.nextWsEndpoint = wsUrl;
  ctx = makeTestContext(runtime);
  const p = ctx.profiles.create({ name: "af", generateFingerprint: true });
  const patched = await ctx.app.inject({
    method: "PATCH",
    url: `/profiles/${p.id}/persona`,
    payload: { creditCards: [CARD] },
  });
  expect(patched.statusCode).toBe(200);
  return p;
}

afterEach(async () => {
  await mock.stop();
});

describe("POST /profiles/:id/autofill/card", () => {
  it("fills the page and reports which fields were set", async () => {
    const p = await boot();
    await ctx.lifecycle.start(p.id);
    mock.evaluateResult = { filled: ["number", "expiry", "cvv", "name"], missing: [] };

    const res = await ctx.app.inject({
      method: "POST",
      url: `/profiles/${p.id}/autofill/card`,
      payload: { set: "personal" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      profileId: p.id,
      set: "personal",
      targetId: "page-1",
      filled: ["number", "expiry", "cvv", "name"],
      missing: [],
    });

    // The page received the fill script with the full card inlined, and the
    // response carried no values.
    expect(mock.evaluations).toHaveLength(1);
    expect(mock.evaluations[0]).toContain("4242424242424242");
    expect(mock.evaluations[0]).toContain("HTMLInputElement.prototype");
    expect(JSON.stringify(res.json())).not.toContain("4242424242424242");

    // Session hygiene: attached to a page target and detached afterwards.
    expect(mock.callsFor("Target.attachToTarget")).toHaveLength(1);
    expect(mock.callsFor("Target.detachFromTarget")).toHaveLength(1);

    await ctx.lifecycle.stop(p.id);
  });

  it("honours an explicit targetId", async () => {
    const p = await boot();
    await ctx.lifecycle.start(p.id);
    mock.evaluateResult = { filled: ["number"], missing: ["cvv", "expiry", "name"] };

    const res = await ctx.app.inject({
      method: "POST",
      url: `/profiles/${p.id}/autofill/card`,
      payload: { set: "personal", targetId: "checkout-tab-7" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().targetId).toBe("checkout-tab-7");
    // No target discovery needed when the caller names the tab.
    expect(mock.callsFor("Target.getTargets")).toHaveLength(0);

    await ctx.lifecycle.stop(p.id);
  });

  it("409s when the profile is not running", async () => {
    const p = await boot();
    const res = await ctx.app.inject({
      method: "POST",
      url: `/profiles/${p.id}/autofill/card`,
      payload: { set: "personal" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("PROFILE_NOT_RUNNING");
  });

  it("409s when the card set does not exist (values never touched)", async () => {
    const p = await boot();
    await ctx.lifecycle.start(p.id);
    const res = await ctx.app.inject({
      method: "POST",
      url: `/profiles/${p.id}/autofill/card`,
      payload: { set: "nope" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("CONFLICT");
    expect(mock.evaluations).toHaveLength(0);
    await ctx.lifecycle.stop(p.id);
  });

  it("409s when there is no page to fill", async () => {
    const p = await boot();
    await ctx.lifecycle.start(p.id);
    mock.pageTargets = [{ targetId: "service-1", type: "service_worker" }];
    const res = await ctx.app.inject({
      method: "POST",
      url: `/profiles/${p.id}/autofill/card`,
      payload: { set: "personal" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("NO_FILL_TARGET");
    await ctx.lifecycle.stop(p.id);
  });

  it("404s for an unknown profile", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/profiles/00000000-0000-4000-8000-000000000000/autofill/card",
      payload: { set: "personal" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("400s on a malformed body", async () => {
    const p = await boot();
    const res = await ctx.app.inject({
      method: "POST",
      url: `/profiles/${p.id}/autofill/card`,
      payload: { set: "" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_FAILED");
  });
});

/**
 * v0.14.5 address/identity autofill: POST /profiles/:id/autofill/address
 * pushes the profile's name plus the persona's phone/DOB/address into the
 * page (inputs AND state selects) over CDP. Values travel INTO the page
 * only; the response names filled fields, never values.
 */

const PERSONA = {
  address: {
    line1: "1 Main St",
    line2: null,
    city: "Toronto",
    state: "ON",
    zip: "M5V 1J1",
  },
  phone: "+1 416 555 0100",
  dob: "01/02/1990",
};

async function bootWithPersona() {
  runtime = new FakeBrowserRuntime();
  mock = new MockCdpServer();
  const { wsUrl } = await mock.start();
  runtime.nextWsEndpoint = wsUrl;
  ctx = makeTestContext(runtime);
  const p = ctx.profiles.create({ name: "Jo Doe", generateFingerprint: true });
  const patched = await ctx.app.inject({
    method: "PATCH",
    url: `/profiles/${p.id}/persona`,
    payload: PERSONA,
  });
  expect(patched.statusCode).toBe(200);
  return p;
}

describe("POST /profiles/:id/autofill/address", () => {
  it("fills the page and reports which fields were set", async () => {
    const p = await bootWithPersona();
    await ctx.lifecycle.start(p.id);
    mock.evaluateResult = {
      filled: ["firstName", "lastName", "phone", "dob", "address1", "city", "state", "zip"],
      missing: ["email", "address2"],
    };

    const res = await ctx.app.inject({
      method: "POST",
      url: `/profiles/${p.id}/autofill/address`,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      profileId: p.id,
      targetId: "page-1",
      filled: ["firstName", "lastName", "phone", "dob", "address1", "city", "state", "zip"],
      missing: ["email", "address2"],
    });

    // The page received the fill script with identity values inlined, the
    // state-select path was part of it, and the response carried no values.
    expect(mock.evaluations).toHaveLength(1);
    expect(mock.evaluations[0]).toContain("1 Main St");
    expect(mock.evaluations[0]).toContain("querySelectorAll(\"select\")");
    expect(JSON.stringify(res.json())).not.toContain("1 Main St");
    expect(JSON.stringify(res.json())).not.toContain("416 555");

    expect(mock.callsFor("Target.attachToTarget")).toHaveLength(1);
    expect(mock.callsFor("Target.detachFromTarget")).toHaveLength(1);

    await ctx.lifecycle.stop(p.id);
  });

  it("honours an explicit targetId", async () => {
    const p = await bootWithPersona();
    await ctx.lifecycle.start(p.id);
    mock.evaluateResult = { filled: ["firstName"], missing: [] };

    const res = await ctx.app.inject({
      method: "POST",
      url: `/profiles/${p.id}/autofill/address`,
      payload: { targetId: "checkout-tab-7" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().targetId).toBe("checkout-tab-7");
    expect(mock.callsFor("Target.getTargets")).toHaveLength(0);

    await ctx.lifecycle.stop(p.id);
  });

  it("derives first/last name from the profile name", async () => {
    const p = await bootWithPersona();
    await ctx.lifecycle.start(p.id);
    mock.evaluateResult = { filled: [], missing: [] };

    await ctx.app.inject({
      method: "POST",
      url: `/profiles/${p.id}/autofill/address`,
      payload: {},
    });
    expect(mock.evaluations).toHaveLength(1);
    expect(mock.evaluations[0]).toContain('"firstName":"Jo"');
    expect(mock.evaluations[0]).toContain('"lastName":"Doe"');

    await ctx.lifecycle.stop(p.id);
  });

  it("409s when the profile is not running", async () => {
    const p = await bootWithPersona();
    const res = await ctx.app.inject({
      method: "POST",
      url: `/profiles/${p.id}/autofill/address`,
      payload: {},
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("PROFILE_NOT_RUNNING");
  });

  it("409s when the persona has no address/identity data (values never touched)", async () => {
    runtime = new FakeBrowserRuntime();
    mock = new MockCdpServer();
    const { wsUrl } = await mock.start();
    runtime.nextWsEndpoint = wsUrl;
    ctx = makeTestContext(runtime);
    const p = ctx.profiles.create({ name: "Jo Doe", generateFingerprint: true });
    await ctx.lifecycle.start(p.id);

    const res = await ctx.app.inject({
      method: "POST",
      url: `/profiles/${p.id}/autofill/address`,
      payload: {},
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("CONFLICT");
    expect(mock.evaluations).toHaveLength(0);

    await ctx.lifecycle.stop(p.id);
  });

  it("409s when there is no page to fill", async () => {
    const p = await bootWithPersona();
    await ctx.lifecycle.start(p.id);
    mock.pageTargets = [{ targetId: "service-1", type: "service_worker" }];
    const res = await ctx.app.inject({
      method: "POST",
      url: `/profiles/${p.id}/autofill/address`,
      payload: {},
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("NO_FILL_TARGET");
    await ctx.lifecycle.stop(p.id);
  });

  it("404s for an unknown profile", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/profiles/00000000-0000-4000-8000-000000000000/autofill/address",
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });
});
