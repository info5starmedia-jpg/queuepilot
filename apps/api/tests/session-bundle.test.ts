import { describe, expect, it } from "vitest";
import { ErrorCodes } from "@queuepilot/contracts";
import {
  createSessionBundle,
  openSessionBundle,
  type BundleCookie,
} from "../src/application/bundles/session-bundle.js";
import { BundleService } from "../src/application/bundles/bundle.service.js";
import { ErrorCodes as Codes } from "@queuepilot/contracts";
import { makeTestContext } from "./helpers.js";

const COOKIES: BundleCookie[] = [
  {
    name: "session",
    value: "abc123",
    domain: ".example.com",
    path: "/",
    expires: 0,
    secure: true,
    httpOnly: true,
  },
];

const MANIFEST = {
  profileName: "checkout-1",
  engineKind: "fury",
  exportedAt: "2026-11-12T03:00:00.000Z",
};

describe("session bundle crypto", () => {
  it("round-trips a bundle under the passphrase", () => {
    const bundle = createSessionBundle("correct horse", MANIFEST, COOKIES);
    const opened = openSessionBundle("correct horse", bundle);
    expect(opened.manifest.profileName).toBe("checkout-1");
    expect(opened.manifest.cookieCount).toBe(1);
    expect(opened.cookies).toEqual(COOKIES);
  });

  it("wrong passphrase fails with BUNDLE_INVALID and no oracle", () => {
    const bundle = createSessionBundle("right", MANIFEST, COOKIES);
    try {
      openSessionBundle("wrong", bundle);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as { code?: string }).code).toBe(ErrorCodes.BUNDLE_INVALID);
      expect((err as Error).message).toContain("wrong passphrase or corrupted");
    }
  });

  it("tampered ciphertext fails authentication", () => {
    const bundle = createSessionBundle("pw", MANIFEST, COOKIES);
    const envelope = JSON.parse(bundle.toString("utf8")) as { ciphertext: string };
    const raw = Buffer.from(envelope.ciphertext, "base64");
    raw[0] = (raw[0] ?? 0) ^ 0xff;
    envelope.ciphertext = raw.toString("base64");
    expect(() => openSessionBundle("pw", Buffer.from(JSON.stringify(envelope)))).toThrow(
      expect.objectContaining({ code: ErrorCodes.BUNDLE_INVALID }),
    );
  });

  it("foreign bytes are not a bundle", () => {
    expect(() => openSessionBundle("pw", Buffer.from("not json"))).toThrow(
      expect.objectContaining({ code: ErrorCodes.BUNDLE_INVALID }),
    );
  });

  it("two bundles of the same payload differ (random salt/iv)", () => {
    const a = createSessionBundle("pw", MANIFEST, COOKIES);
    const b = createSessionBundle("pw", MANIFEST, COOKIES);
    expect(a.equals(b)).toBe(false);
  });
});

describe("BundleService", () => {
  function makeService(opts: { running?: boolean } = {}) {
    const exported: BundleCookie[][] = [];
    const imported: BundleCookie[][] = [];
    const service = new BundleService(
      {
        get: (id: string) => ({
          id,
          name: "p1",
          group: "default",
          tags: [],
          notes: "",
          proxyId: null,
        }),
      } as never,
      {
        activeRun: () => (opts.running === false ? null : ({ id: "r1" } as never)),
        sessionFor: () =>
          opts.running === false
            ? null
            : ({ wsEndpoint: "ws://127.0.0.1:9222" } as never),
        engineKind: () => "fury",
        listTabs: () => ({ tabs: [], partitions: [] }),
      } as never,
      {
        export: async () => {
          exported.push(COOKIES);
          return COOKIES;
        },
        import: async (_ws: string, cookies: BundleCookie[]) => {
          imported.push(cookies);
        },
      },
    );
    return { service, exported, imported };
  }

  it("exports cookies from the running engine into an encrypted bundle", async () => {
    const { service } = makeService();
    const out = await service.exportBundle("p1", "pw");
    expect(out.cookieCount).toBe(1);
    const opened = openSessionBundle("pw", Buffer.from(out.bundle, "base64"));
    expect(opened.cookies).toEqual(COOKIES);
    expect(opened.manifest.engineKind).toBe("fury");
  });

  it("refuses export when the profile is not running", async () => {
    const { service } = makeService({ running: false });
    await expect(service.exportBundle("p1", "pw")).rejects.toMatchObject({
      code: Codes.PROFILE_NOT_RUNNING,
    });
  });

  it("imports a bundle into the running engine", async () => {
    const { service, imported } = makeService();
    const exported = await service.exportBundle("p1", "pw");
    const result = await service.importBundle("p1", "pw", exported.bundle);
    expect(result.imported).toBe(1);
    expect(imported[0]).toEqual(COOKIES);
  });

  it("wrong passphrase at import is BUNDLE_INVALID, nothing imported", async () => {
    const { service, imported } = makeService();
    const exported = await service.exportBundle("p1", "right");
    await expect(service.importBundle("p1", "wrong", exported.bundle)).rejects.toMatchObject({
      code: Codes.BUNDLE_INVALID,
    });
    expect(imported).toHaveLength(0);
  });
});

describe("BundleService v2 restore", () => {
  function ctx() {
    const { profiles, proxies, lifecycle } = makeTestContext();
    const imported: BundleCookie[][] = [];
    const service = new BundleService(profiles, lifecycle, {
      export: async () => COOKIES,
      import: async (_ws: string, cookies: BundleCookie[]) => {
        imported.push(cookies);
      },
    }, proxies);
    return { service, profiles, proxies, imported };
  }

  it("restores a bundle into a NEW profile with metadata and cookies", async () => {
    const { service, profiles, imported } = ctx();
    const bundle = createSessionBundle("pw", {
      ...MANIFEST,
      profileName: "roam-me",
      group: "family",
      tags: ["a", "b"],
      notes: "from the other machine",
      tabUrls: ["https://example.com/one"],

    }, COOKIES);
    const out = await service.restoreBundle("pw", bundle.toString("base64"), { startNow: true });
    expect(out.created).toBe(true);
    expect(out.cookiesImported).toBe(COOKIES.length);
    expect(imported).toHaveLength(1);
    const p = profiles.get(out.profileId);
    expect(p.group).toBe("family");
    expect(p.tags).toEqual(["a", "b"]);
  });

  it("matches an existing local proxy and never invents credentials", async () => {
    const { service, profiles, proxies } = ctx();
    const proxy = proxies.create({ name: "home", type: "http", host: "1.2.3.4", port: 8080, username: "u", password: "p" });
    const bundle = createSessionBundle("pw", {
      ...MANIFEST,
      profileName: "with-proxy",
      proxy: { type: "http", host: "1.2.3.4", port: 8080, username: "u" },
      // cookieCount is computed by createSessionBundle
    }, []);
    const out = await service.restoreBundle("pw", bundle.toString("base64"));
    expect(out.proxyMatched).toBe(true);
    expect(profiles.get(out.profileId).proxyId).toBe(proxy.id);

    const unknown = createSessionBundle("pw", {
      ...MANIFEST,
      profileName: "no-proxy-match",
      proxy: { type: "http", host: "9.9.9.9", port: 1, username: null },
      // cookieCount is computed by createSessionBundle
    }, []);
    const out2 = await service.restoreBundle("pw", unknown.toString("base64"));
    expect(out2.proxyMatched).toBe(false);
    expect(out2.warnings.join(" ")).toMatch(/not on this machine/);
    expect(profiles.get(out2.profileId).proxyId).toBeNull();
  });

  it("upserts an existing profile by name instead of duplicating", async () => {
    const { service, profiles } = ctx();
    const first = await service.restoreBundle("pw", createSessionBundle("pw", { ...MANIFEST, profileName: "twice" }, []).toString("base64"));
    const second = await service.restoreBundle("pw", createSessionBundle("pw", { ...MANIFEST, profileName: "twice", group: "g2" }, []).toString("base64"));
    expect(second.created).toBe(false);
    expect(profiles.get(second.profileId).group).toBe("g2");
    expect(profiles.list().filter((p) => p.name === "twice")).toHaveLength(1);
  });

  it("wrong passphrase refuses before touching anything", async () => {
    const { service, profiles } = ctx();
    await expect(
      service.restoreBundle("nope", createSessionBundle("pw", { ...MANIFEST, profileName: "ghost" }, []).toString("base64")),
    ).rejects.toMatchObject({ code: ErrorCodes.BUNDLE_INVALID });
    expect(profiles.list().filter((p) => p.name === "ghost")).toHaveLength(0);
  });
});
