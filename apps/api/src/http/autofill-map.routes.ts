import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AutofillMapService } from "../application/autofill/autofill-map.service.js";

/**
 * J4 autofill map.
 *   GET  /autofill/map                      { exists, blocks, errors }
 *   PUT  /autofill/map                      { text }  save (refused if it has errors)
 *   POST /profiles/:id/autofill/map         fill the profile's page from the map
 *   POST /autofill/map/broadcast            { profileIds, ...options } fill many profiles
 * Browser-origin denied: fills move card numbers, codes and passcodes.
 */
const Options = z
  .object({
    targetId: z.string().min(1).max(100).optional(),
    card: z.string().min(1).max(60).optional(),
    defaultMode: z.enum(["human", "machine"]).optional(),
    fillPopulated: z.boolean().optional(),
    stripCommas: z.boolean().optional(),
    wpm: z.number().int().min(20).max(400).optional(),
  })
  .strict();

export function registerAutofillMapRoutes(app: FastifyInstance, svc: AutofillMapService): void {
  app.get("/autofill/map", async () => svc.status());
  app.put("/autofill/map", { bodyLimit: 512 * 1024 }, async (req) =>
    svc.save(z.object({ text: z.string().max(500_000) }).strict().parse(req.body ?? {}).text),
  );
  app.post("/profiles/:id/autofill/map", async (req) => svc.fill((req.params as { id: string }).id, Options.parse(req.body ?? {})));
  app.post("/autofill/map/broadcast", async (req) => {
    const { profileIds, ...opts } = Options.extend({ profileIds: z.array(z.string().uuid()).min(1).max(500) }).parse(req.body ?? {});
    return { results: await svc.broadcast(profileIds, opts) };
  });
}
