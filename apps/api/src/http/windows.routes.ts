import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { PersonaWindowBoundsSchema } from "@queuepilot/contracts";
import type { WindowTilingService, TilePreset } from "../application/windows/window-tiling.service.js";

const BoundsBodySchema = z.object({
  bounds: PersonaWindowBoundsSchema,
});

const AreaSchema = z.object({
  left: z.number().int().min(-10000).max(10000).default(0),
  top: z.number().int().min(-10000).max(10000).default(0),
  width: z.number().int().min(320).max(20000).default(1920),
  height: z.number().int().min(240).max(20000).default(1040),
});

const BatchTileBodySchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(500),
  preset: z.enum(["cascade", "grid"]),
  /** Work area to tile into; defaults to a 1920x1040 primary-monitor area. */
  area: AreaSchema.default({}),
});

const RestoreBodySchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(500),
});

/** Window tiling (A3) — placement presets over the running engine windows. */
export function registerWindowRoutes(
  app: FastifyInstance,
  tiling: WindowTilingService,
): void {
  app.post("/profiles/:id/window/bounds", async (req) => {
    const { id } = req.params as { id: string };
    const body = BoundsBodySchema.parse(req.body ?? {});
    return tiling.setBounds(id, body.bounds);
  });

  app.post("/profiles/batch-tile", async (req) => {
    const body = BatchTileBodySchema.parse(req.body ?? {});
    return tiling.tile(body.ids, body.preset as TilePreset, body.area);
  });

  app.post("/profiles/batch-window-restore", async (req) => {
    const body = RestoreBodySchema.parse(req.body ?? {});
    return tiling.restore(body.ids);
  });
}
