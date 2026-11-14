import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ExtensionRegistry } from "../application/extensions/extension-registry.js";

export interface ExtensionDeps {
  extensions: ExtensionRegistry;
}

const InstallSchema = z.object({
  /** Absolute path to a .crx / .zip / unpacked folder on THIS machine. */
  sourcePath: z.string().min(1).max(1000),
});

const CopySchema = z.object({
  fromProfileId: z.string().uuid(),
});

export function registerExtensionRoutes(
  app: FastifyInstance,
  deps: ExtensionDeps,
): void {
  const { extensions } = deps;

  app.get("/profiles/:id/extensions", async (req) => {
    const { id } = req.params as { id: string };
    return { extensions: extensions.list(id) };
  });

  app.post("/profiles/:id/extensions", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = InstallSchema.parse(req.body);
    const entry = extensions.install(id, body.sourcePath);
    return reply.code(201).send(entry);
  });

  /** Storage-free by design — see ExtensionRegistry.copyFrom. */
  app.post("/profiles/:id/extensions/:extId/copy", async (req, reply) => {
    const { id, extId } = req.params as { id: string; extId: string };
    const body = CopySchema.parse(req.body);
    const entry = extensions.copyFrom(id, body.fromProfileId, extId);
    return reply.code(201).send(entry);
  });

  app.delete("/profiles/:id/extensions/:extId", async (req) => {
    const { id, extId } = req.params as { id: string; extId: string };
    return { removed: extensions.remove(id, extId) };
  });
}
