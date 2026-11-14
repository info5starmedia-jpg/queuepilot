import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { JylRegistry } from "../application/jyl/jyl-registry.js";

export interface JylDeps {
  jyl: JylRegistry;
}

const RunSchema = z.object({
  kind: z.enum(["command", "macro"]),
  name: z.string().min(1).max(200),
  args: z.string().max(4000).default(""),
  profileId: z.string().uuid().optional(),
});

export function registerJylRoutes(app: FastifyInstance, deps: JylDeps): void {
  const { jyl } = deps;

  app.get("/jyl", async () => jyl.list());
  app.get("/jyl/logs", async () => ({ logs: jyl.recentLogs() }));
  app.post("/jyl/rescan", async () => jyl.rescan());

  app.post("/jyl/run", async (req) => {
    const body = RunSchema.parse(req.body);
    const ctx = { profileId: body.profileId };
    return body.kind === "command"
      ? jyl.runCommand(body.name, body.args, ctx)
      : jyl.runMacro(body.name, body.args, ctx);
  });
}
