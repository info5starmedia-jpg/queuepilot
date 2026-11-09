import type { FastifyInstance } from "fastify";
import type { BrowserLifecycleService } from "../application/lifecycle/browser.lifecycle.service.js";

/** Native run-control API (QueuePilot's own shape, not the compat surface). */
export function registerRunRoutes(app: FastifyInstance, lifecycle: BrowserLifecycleService): void {
  app.post("/profiles/:id/start", async (req, reply) => {
    const { id } = req.params as { id: string };
    const run = await lifecycle.start(id);
    return reply.code(201).send(run);
  });

  app.post("/profiles/:id/stop", async (req) => {
    const { id } = req.params as { id: string };
    const run = await lifecycle.stop(id);
    return { stopped: run !== null, run };
  });

  app.get("/profiles/:id/run", async (req) => {
    const { id } = req.params as { id: string };
    return { run: lifecycle.activeRun(id) };
  });

  app.get("/profiles/:id/runs", async (req) => {
    const { id } = req.params as { id: string };
    return { runs: lifecycle.listRuns(id) };
  });

  /**
   * "Applies at next start" signal: drift between what the running engine
   * was launched with and the profile's current identity/proxy pointers.
   */
  app.get("/profiles/:id/drift", async (req) => {
    const { id } = req.params as { id: string };
    return { drift: lifecycle.identityDrift(id) };
  });
}
