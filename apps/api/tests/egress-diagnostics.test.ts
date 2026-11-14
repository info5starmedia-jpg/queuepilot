import { describe, expect, it } from "vitest";
import { makeTestContext } from "./helpers.js";
import { redactProxyUrl } from "../src/application/lifecycle/browser.lifecycle.service.js";

describe("egress diagnostics", () => {
  it("GET /profiles/:id/egress reports running state and null egress without a proxy", async () => {
    const { app, lifecycle, profiles } = makeTestContext();
    const p = profiles.create({ name: "diag", generateFingerprint: true });
    const stopped = await app.inject({ method: "GET", url: `/profiles/${p.id}/egress` });
    expect(stopped.json()).toMatchObject({
      profileId: p.id,
      running: false,
      proxyUrl: null,
      proxySource: "none",
      egress: null,
    });

    await lifecycle.start(p.id);
    const running = await app.inject({ method: "GET", url: `/profiles/${p.id}/egress` });
    expect(running.json()).toMatchObject({
      profileId: p.id,
      running: true,
      proxyUrl: null,
      proxySource: "none",
      egress: null,
    });
    await lifecycle.stop(p.id);
  });

  it("redactProxyUrl keeps host/port/scheme, never credentials", () => {
    expect(redactProxyUrl(null)).toBeNull();
    expect(redactProxyUrl("http://user:pass@proxy.example:8080")).toBe(
      "http://***@proxy.example:8080/",
    );
    expect(redactProxyUrl("http://proxy.example:8080")).toBe(
      "http://proxy.example:8080/",
    );
    expect(redactProxyUrl("not a url")).toBe("(unparseable proxy url)");
  });
});
