import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { JylRegistry } from "../application/jyl/jyl-registry.js";

export interface JylDeps {
  jyl: JylRegistry;
  /** Audit A-rec #3: throws unless scripting endpoints are opted in. */
  assertScriptingEnabled: () => void;
}

const RunSchema = z.object({
  kind: z.enum(["command", "macro"]),
  name: z.string().min(1).max(200),
  args: z.string().max(4000).default(""),
  profileId: z.string().uuid().optional(),
});

export function registerJylRoutes(app: FastifyInstance, deps: JylDeps): void {
  const { jyl, assertScriptingEnabled } = deps;

  app.get("/jyl", async () => jyl.list());
  app.get("/jyl/logs", async () => ({ logs: jyl.recentLogs() }));
  app.post("/jyl/rescan", async () => {
    assertScriptingEnabled(); // loads new module code from disk
    return jyl.rescan();
  });

  app.post("/jyl/run", async (req) => {
    assertScriptingEnabled(); // runs operator scripts (automation)
    const body = RunSchema.parse(req.body);
    const ctx = { profileId: body.profileId };
    return body.kind === "command"
      ? jyl.runCommand(body.name, body.args, ctx)
      : jyl.runMacro(body.name, body.args, ctx);
  });

  // Module-provided web endpoints. The wildcard is one route; the registry
  // resolves "<module>.mjs/<path>" per request, so rescans never need to
  // re-register Fastify routes.
  app.route({
    method: ["GET", "POST", "PUT", "DELETE"],
    url: "/jyl/endpoint/*",
    handler: async (req, reply) => {
      assertScriptingEnabled(); // dispatches into module code
      const rest = (req.params as { "*": string })["*"] ?? "";
      const query = req.query as Record<string, string>;
      const body =
        req.method === "GET" || req.method === "DELETE" ? null : (req.body ?? null);
      const out = await jyl.dispatch(req.method, rest, { query, body });
      if (!out.found) {
        return reply.code(404).send({
          error: { code: "NOT_FOUND", message: `no JYL endpoint for ${req.method} /${rest}` },
        });
      }
      return out.result;
    },
  });
}
