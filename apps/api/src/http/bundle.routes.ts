import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { BundleService } from "../application/bundles/bundle.service.js";

const ExportSchema = z.object({
  passphrase: z.string().min(1),
});

const ImportSchema = z.object({
  passphrase: z.string().min(1),
  bundle: z.string().min(1), // base64 .qpbundle content
});

const RestoreSchema = z.object({
  passphrase: z.string().min(1),
  bundle: z.string().min(1),
  startNow: z.boolean().default(false),
});

/** Session bundle export/import — encrypted, passphrase-protected roaming. */
export function registerBundleRoutes(app: FastifyInstance, bundles: BundleService): void {
  app.post("/profiles/:id/bundle/export", async (req) => {
    const { id } = req.params as { id: string };
    const { passphrase } = ExportSchema.parse(req.body);
    return bundles.exportBundle(id, passphrase);
  });

  app.post("/profiles/:id/bundle/import", async (req) => {
    const { id } = req.params as { id: string };
    const { passphrase, bundle } = ImportSchema.parse(req.body);
    return bundles.importBundle(id, passphrase, bundle);
  });

  // v2 roaming: one call upserts the profile by name, optionally starts it
  // and finishes the import (cookies in, tabs reopened).
  app.post("/bundles/restore", async (req) => {
    const { passphrase, bundle, startNow } = RestoreSchema.parse(req.body);
    return bundles.restoreBundle(passphrase, bundle, { startNow });
  });
}
