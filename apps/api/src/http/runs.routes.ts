import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { TempProxyInputSchema } from "@queuepilot/contracts";
import type { BrowserLifecycleService } from "../application/lifecycle/browser.lifecycle.service.js";

const StartRunBodySchema = z
  .object({
    /**
     * Optional one-shot proxy for this launch only (Jancy-style temp proxy):
     * used by the engine for this run, never persisted, and the profile's own
     * proxy applies again at next start.
     */
    tempProxy: TempProxyInputSchema.nullish(),
  })
  .strict();

/** Native run-control API (QueuePilot's own shape, not the compat surface). */
export function registerRunRoutes(
  app: FastifyInstance,
  lifecycle: BrowserLifecycleService,
): void {
  app.post("/profiles/:id/start", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = StartRunBodySchema.parse(req.body ?? {});
    const run = await lifecycle.start(id, {
      tempProxy: body.tempProxy ?? null,
    });
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

  /**
   * Attestation: what the live engine ACTUALLY materialized vs the launch
   * snapshot. verdict "match" | "mismatch" | "unattested" (no identity of
   * record); 501 ATTESTATION_UNSUPPORTED when the runtime can't probe.
   */
  app.get("/profiles/:id/attest", async (req) => {
    const { id } = req.params as { id: string };
    return lifecycle.attest(id);
  });
}
