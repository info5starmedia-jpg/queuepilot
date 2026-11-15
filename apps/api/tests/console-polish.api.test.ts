import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeTestContext, type TestContext } from "./helpers.js";
import { ProxyProviderService } from "../src/application/providers/provider.service.js";
import { ProxyProviderRepository } from "../src/application/providers/provider.repository.js";
import { ProxyRepository } from "../src/application/proxies/proxy.repository.js";
import { openTestDatabase } from "../src/infrastructure/database.js";

/**
 * v0.14.10 console polish: proxy-provider star (one default), profile
 * favorite filter, persona favorite/tabColor PATCH.
 */

describe("proxy provider star", () => {
  let dir: string;
  let svc: ProxyProviderService;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "qp-star-"));
    fs.writeFileSync(path.join(dir, "p.txt"), "1.1.1.1:8080:u:p\n2.2.2.2:8080\n");
    const db = openTestDatabase();
    svc = new ProxyProviderService(
      new ProxyProviderRepository(db),
      new ProxyRepository(db),
    );
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function createProvider(name: string) {
    fs.writeFileSync(path.join(dir, `${name}.txt`), "3.3.3.3:8080\n");
    return svc.create({ name, sourcePath: path.join(dir, `${name}.txt`) });
  }

  it("star one provider; the previous default loses its star", async () => {
    const a = await createProvider("a");
    const b = await createProvider("b");
    svc.setStarred(a.provider.id, true);
    expect(svc.get(a.provider.id).starred).toBe(true);
    expect(svc.get(b.provider.id).starred).toBe(false);

    svc.setStarred(b.provider.id, true);
    expect(svc.get(b.provider.id).starred).toBe(true);
    expect(svc.get(a.provider.id).starred).toBe(false); // exactly one default
  });

  it("unstar leaves the others untouched", async () => {
    const a = await createProvider("a");
    svc.setStarred(a.provider.id, true);
    svc.setStarred(a.provider.id, false);
    expect(svc.get(a.provider.id).starred).toBe(false);
  });

  it("404s for an unknown provider", () => {
    expect(() => svc.setStarred("00000000-0000-4000-8000-000000000000", true)).toThrow(
      /not found/,
    );
  });
});

describe("profile favorite (persona bag + filter)", () => {
  let ctx: TestContext;

  it("PATCH persona favorite, list filter favorite=true", async () => {
    ctx = makeTestContext();
    const a = ctx.profiles.create({ name: "fav-a", generateFingerprint: true });
    const b = ctx.profiles.create({ name: "fav-b", generateFingerprint: true });

    const patch = await ctx.app.inject({
      method: "PATCH",
      url: `/profiles/${a.id}/persona`,
      payload: { favorite: true, tabColor: "#f00" },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().extra.favorite).toBe(true);
    expect(patch.json().extra.tabColor).toBe("#f00");

    const favs = await ctx.app.inject({ method: "GET", url: "/profiles?favorite=true" });
    expect(favs.json().profiles.map((p: { id: string }) => p.id)).toEqual([a.id]);

    const all = await ctx.app.inject({ method: "GET", url: "/profiles" });
    expect(all.json().profiles).toHaveLength(2);

    const bad = await ctx.app.inject({
      method: "PATCH",
      url: `/profiles/${b.id}/persona`,
      payload: { tabColor: "red" },
    });
    expect(bad.statusCode).toBe(400);
  });
});
