import { describe, expect, it } from "vitest";
import { makeTestContext } from "./helpers.js";
import { openTestDatabase } from "../src/infrastructure/database.js";
import { ProfileRepository } from "../src/application/profiles/profile.repository.js";
import { cardSecretKey } from "../src/application/profiles/card-secrets.js";

describe("profile trash/restore (v0.15.1)", () => {
  it("trash hides the profile from lists, gets, and group counts", async () => {
    const ctx = makeTestContext();
    const a = ctx.profiles.create({ name: "keep", group: "ads", generateFingerprint: true });
    const b = ctx.profiles.create({ name: "gone", group: "ads", generateFingerprint: true });

    const trashRes = await ctx.app.inject({ method: "POST", url: `/profiles/${b.id}/trash` });
    expect(trashRes.statusCode).toBe(200);

    const listRes = await ctx.app.inject({ method: "GET", url: "/profiles" });
    expect(listRes.json().profiles.map((p: { id: string }) => p.id)).toEqual([a.id]);

    const getRes = await ctx.app.inject({ method: "GET", url: `/profiles/${b.id}` });
    expect(getRes.statusCode).toBe(404);

    const groupsRes = await ctx.app.inject({ method: "GET", url: "/profile-groups" });
    expect(groupsRes.json().groups).toEqual([{ group: "ads", total: 1, running: 0 }]);
  });

  it("GET /profiles/trash lists trashed profiles; restore brings them back", async () => {
    const ctx = makeTestContext();
    const p = ctx.profiles.create({ name: "roundtrip", generateFingerprint: true });

    await ctx.app.inject({ method: "POST", url: `/profiles/${p.id}/trash` });

    const trashList = await ctx.app.inject({ method: "GET", url: "/profiles/trash" });
    expect(trashList.statusCode).toBe(200);
    expect(trashList.json().profiles).toHaveLength(1);
    expect(trashList.json().profiles[0].deletedAt).toBeTruthy();

    const restoreRes = await ctx.app.inject({ method: "POST", url: `/profiles/${p.id}/restore` });
    expect(restoreRes.statusCode).toBe(200);
    expect(restoreRes.json().deletedAt ?? null).toBeNull();

    const listRes = await ctx.app.inject({ method: "GET", url: "/profiles" });
    expect(listRes.json().profiles).toHaveLength(1);
    const trashAfter = await ctx.app.inject({ method: "GET", url: "/profiles/trash" });
    expect(trashAfter.json().profiles).toHaveLength(0);
  });

  it("restore of a live profile 404s", async () => {
    const ctx = makeTestContext();
    const p = ctx.profiles.create({ name: "live", generateFingerprint: true });
    const res = await ctx.app.inject({ method: "POST", url: `/profiles/${p.id}/restore` });
    expect(res.statusCode).toBe(404);
  });

  it("trash refuses while the browser is running", async () => {
    const ctx = makeTestContext();
    const p = ctx.profiles.create({ name: "running", generateFingerprint: true });
    const start = await ctx.app.inject({ method: "POST", url: `/profiles/${p.id}/start`, payload: {} });
    expect(start.statusCode).toBe(201);

    const res = await ctx.app.inject({ method: "POST", url: `/profiles/${p.id}/trash` });
    expect(res.statusCode).toBe(409);

    // And it is still live.
    const listRes = await ctx.app.inject({ method: "GET", url: "/profiles" });
    expect(listRes.json().profiles).toHaveLength(1);
  });

  it("purge permanently deletes and wipes card PAN secrets", async () => {
    const ctx = makeTestContext();
    const p = ctx.profiles.create({ name: "secrets", generateFingerprint: true });

    // Seal a card: PAN goes to the SecretStore under card:<id>:<set>:number.
    await ctx.app.inject({
      method: "PATCH",
      url: `/profiles/${p.id}/persona`,
      payload: { creditCards: [{ set: "main", number: "4111111111111111", cvv: "123" }] },
    });
    expect(ctx.secrets.get(cardSecretKey(p.id, "main"))).toBe("4111111111111111");

    await ctx.app.inject({ method: "POST", url: `/profiles/${p.id}/trash` });
    const purge = await ctx.app.inject({ method: "DELETE", url: `/profiles/${p.id}/trash` });
    expect(purge.statusCode).toBe(204);

    const trashList = await ctx.app.inject({ method: "GET", url: "/profiles/trash" });
    expect(trashList.json().profiles).toHaveLength(0);
    expect(ctx.secrets.get(cardSecretKey(p.id, "main"))).toBeNull();

    // Purge of a non-trashed profile 404s — permanent delete is trash-only.
    const other = ctx.profiles.create({ name: "live2", generateFingerprint: true });
    const badPurge = await ctx.app.inject({ method: "DELETE", url: `/profiles/${other.id}/trash` });
    expect(badPurge.statusCode).toBe(404);
    const stillThere = await ctx.app.inject({ method: "GET", url: `/profiles/${other.id}` });
    expect(stillThere.statusCode).toBe(200);
  });

  it("a trashed profile cannot be launched", async () => {
    const ctx = makeTestContext();
    const p = ctx.profiles.create({ name: "cant-start", generateFingerprint: true });
    await ctx.app.inject({ method: "POST", url: `/profiles/${p.id}/trash` });
    const res = await ctx.app.inject({ method: "POST", url: `/profiles/${p.id}/start`, payload: {} });
    expect(res.statusCode).toBe(404);
  });

  it("provider-key lookup skips trashed rows so refresh cannot collide", () => {
    const db = openTestDatabase();
    const repo = new ProfileRepository(db);
    const now = new Date().toISOString();
    const profile = {
      id: "11111111-1111-4111-8111-111111111111",
      name: "imported",
      group: "default",
      proxyId: null,
      identityId: null,
      status: "idle" as const,
      notes: "",
      tags: [],
      email: "a@b.c",
      providerId: "22222222-2222-4222-8222-222222222222",
      providerKey: "row-1",
      extra: {},
      createdAt: now,
      updatedAt: now,
    };
    repo.create(profile);
    expect(repo.getByProviderKey(profile.providerId!, "row-1")?.id).toBe(profile.id);

    repo.trash(profile.id);
    // The unique index provider_profile_key would reject a re-import upsert
    // if the lookup still saw this row — it must not.
    expect(repo.getByProviderKey(profile.providerId!, "row-1")).toBeNull();
    // The row itself is still there (it is in the trash, not gone).
    expect(repo.getTrashed(profile.id)?.id).toBe(profile.id);
  });
});
