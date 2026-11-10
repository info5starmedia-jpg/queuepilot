import { describe, expect, it } from "vitest";
import { makeTestContext } from "./helpers.js";

/** The dashboard is static assets served by the API itself — no build step. */
describe("web dashboard", () => {
  it("serves the console at /", async () => {
    const { app } = makeTestContext();
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("QueuePilot");
    expect(res.body).toContain("/dashboard/app.js");
  });

  it("serves js and css assets with correct content types", async () => {
    const { app } = makeTestContext();
    const js = await app.inject({ method: "GET", url: "/dashboard/app.js" });
    expect(js.statusCode).toBe(200);
    expect(js.headers["content-type"]).toContain("text/javascript");

    const css = await app.inject({
      method: "GET",
      url: "/dashboard/styles.css",
    });
    expect(css.statusCode).toBe(200);
    expect(css.headers["content-type"]).toContain("text/css");
  });

  it("blocks traversal and unknown assets", async () => {
    const { app } = makeTestContext();
    for (const bad of [
      "../app.ts",
      "..%2F..%2Fapp.ts",
      ".gitignore",
      "nope.exe",
      "sub/dir.js",
    ]) {
      const res = await app.inject({ method: "GET", url: `/dashboard/${bad}` });
      expect(res.statusCode).toBe(404);
    }
  });
});
