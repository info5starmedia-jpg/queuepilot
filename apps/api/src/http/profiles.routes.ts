import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { CreateProfileInputSchema, UpdateProfileInputSchema } from "@queuepilot/contracts";
import type { ProfileService } from "../application/profiles/profile.service.js";
import { maskCard, personaFieldsOf } from "../application/profiles/persona-fields.js";
import {
  currentProxyIndex,
  maskProxyEntry,
  profileProxyEntries,
} from "../application/profiles/profile-proxies.js";
import type { TotpService } from "../application/profiles/totp.service.js";
import type { ProxyService } from "../application/proxies/proxy.service.js";
import { importProfilesCsv } from "../application/profiles/profile-import.js";

const ImportBodySchema = z.object({
  csv: z.string().min(1).max(2_000_000),
  dryRun: z.boolean().default(false),
  upsert: z.boolean().default(true),
});

const RenameGroupSchema = z.object({
  from: z.string().min(1).max(120),
  to: z.string().min(1).max(120),
});

const BatchMoveSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(500),
  group: z.string().min(1).max(120),
});

export function registerProfileRoutes(
  app: FastifyInstance,
  service: ProfileService,
  proxies: ProxyService,
  lifecycle?: { ensureIdle(profileId: string): Promise<void> },
  totp?: TotpService,
): void {
  // P6.1: bulk CSV import. Dry-run first, then apply — a bad row never
  // aborts the file.
  app.post("/profiles/import", async (req) => {
    const body = ImportBodySchema.parse(req.body);
    return importProfilesCsv(service, proxies, body.csv, {
      dryRun: body.dryRun,
      upsert: body.upsert,
    });
  });

  app.get("/profiles", async (req) => {
    const q = req.query as { group?: string; query?: string; favorite?: string };
    const filter: { group?: string; query?: string } = {};
    if (q.group !== undefined) filter.group = q.group;
    if (q.query !== undefined) filter.query = q.query;
    let profiles = service.list(filter);
    // Jancy favorite filter — reads the persona bag (extra.favorite).
    if (q.favorite === "true") {
      profiles = profiles.filter((p) => personaFieldsOf(p.extra).favorite);
    }
    return { profiles };
  });

  // Trash bin (v0.15.1) — registered before /profiles/:id so the static path
  // wins regardless of router precedence rules.
  app.get("/profiles/trash", async () => ({ profiles: service.listTrashed() }));

  app.post("/profiles/:id/trash", async (req) => {
    const { id } = req.params as { id: string };
    service.trash(id);
    return { trashed: true };
  });

  app.post("/profiles/:id/restore", async (req) => {
    const { id } = req.params as { id: string };
    return service.restore(id);
  });

  // Permanent delete — ONLY from the trash. Live deletes stay on
  // DELETE /profiles/:id. Waits out in-flight launches like the live delete.
  app.delete("/profiles/:id/trash", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (lifecycle) await lifecycle.ensureIdle(id);
    service.purge(id);
    return reply.code(204).send();
  });

  // Folder-tab aggregates for the console's group tabs (v0.14.16).
  app.get("/profile-groups", async () => ({ groups: service.groups() }));

  // Rename a folder tab (v0.14.17). Moving a single profile between groups
  // is the existing PATCH /profiles/:id {group}.
  app.post("/profile-groups/rename", async (req) => {
    const body = RenameGroupSchema.parse(req.body ?? {});
    return service.renameGroup(body.from, body.to);
  });

  // Move many profiles into one group (v0.14.17 batch bar).
  app.post("/profiles/batch-move", async (req) => {
    const body = BatchMoveSchema.parse(req.body ?? {});
    return service.moveToGroup(body.ids, body.group);
  });

  app.post("/profiles", async (req, reply) => {
    const input = CreateProfileInputSchema.parse(req.body);
    const profile = service.create(input);
    return reply.code(201).send(profile);
  });

  app.get("/profiles/:id", async (req) => {
    const { id } = req.params as { id: string };
    return service.get(id);
  });

  app.patch("/profiles/:id", async (req) => {
    const { id } = req.params as { id: string };
    const input = UpdateProfileInputSchema.parse(req.body);
    return service.update(id, input);
  });

  app.post("/profiles/:id/fingerprint/regenerate", async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { platform?: "windows" | "macos" | "linux" };
    return service.regenerateFingerprint(id, body.platform);
  });

  // Jancy clone — same persona/proxy/group, fresh fingerprint identity.
  app.post("/profiles/:id/clone", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { name?: string };
    return reply.code(201).send(service.clone(id, body.name));
  });

  // Jancy 2FA/persona columns — typed merge over profile.extra.
  app.patch("/profiles/:id/persona", async (req) => {
    const { id } = req.params as { id: string };
    return service.updatePersona(id, req.body);
  });

  // SMS cycling (Jancy's rotate command): advances the persisted index and
  // returns the newly current number. 409 CONFLICT when there is nothing to
  // cycle — never a silent no-op.
  app.post("/profiles/:id/sms/rotate", async (req) => {
    const { id } = req.params as { id: string };
    return service.rotateSms(id);
  });

  // Credit-card sets — MASKED reads only (last4 + hasCvv + metadata). Full
  // PANs are write-only via PATCH /profiles/:id/persona; the raw extra bag
  // stays the storage of record.
  app.get("/profiles/:id/cards", async (req) => {
    const { id } = req.params as { id: string };
    const profile = service.get(id);
    const fields = personaFieldsOf(profile.extra);
    return { cards: fields.creditCards.map(maskCard) };
  });

  // Per-profile proxy list (Jancy's proxies column) — masked reads + cycling.
  // The current entry feeds launches when the profile has no attached proxy
  // (see BrowserLifecycleService.start). Passwords are never echoed.
  app.get("/profiles/:id/proxies", async (req) => {
    const { id } = req.params as { id: string };
    const profile = service.get(id);
    const entries = profileProxyEntries(profile.extra);
    const raw = currentProxyIndex(profile.extra, entries.length);
    return {
      index: raw,
      total: entries.length,
      entries: entries.map(maskProxyEntry),
    };
  });

  app.post("/profiles/:id/proxies/rotate", async (req) => {
    const { id } = req.params as { id: string };
    return service.rotateProxy(id);
  });

  app.delete("/profiles/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    // Wait out any in-flight start/stop before the row goes (EBUSY guard).
    if (lifecycle) await lifecycle.ensureIdle(id);
    service.delete(id);
    return reply.code(204).send();
  });

  if (totp) {
    const SeedSchema = z.object({ seed: z.string().min(8).max(200) });
    // The seed is write-only over the API: PUT to set, GET answers the
    // current code + rollover — the seed itself never leaves the SecretStore.
    app.put("/profiles/:id/totp", async (req) => {
      const { id } = req.params as { id: string };
      const body = SeedSchema.parse(req.body);
      totp.setSeed(id, body.seed);
      return { seeded: true };
    });
    app.get("/profiles/:id/totp", async (req) => {
      const { id } = req.params as { id: string };
      return totp.current(id);
    });
    app.delete("/profiles/:id/totp", async (req) => {
      const { id } = req.params as { id: string };
      totp.removeSeed(id);
      return { seeded: false };
    });
  }
}
