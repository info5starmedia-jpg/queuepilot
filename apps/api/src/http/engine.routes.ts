import type { FastifyInstance } from "fastify";
import type { EngineHealthService } from "../application/engine/engine-health.service.js";
import type { EngineUpdateService } from "../application/engine/engine-update.service.js";

/**
 * Engine pre-flight endpoints. /engine/health is cheap and safe to poll;
 * /engine/self-test actually spawns a throwaway browser, so it is POST-only
 * and expected to be called on demand, not scraped.
 *
 * C1 one-click updates: GET /engine/update checks the manifest (free, no
 * download); POST /engine/update starts the checksummed install in the
 * background — only with Settings → Engine → "Allow engine binary
 * downloads" on, one at a time, and never for a cross-site browser request
 * (the origin-deny hook covers this path).
 */
export function registerEngineRoutes(
  app: FastifyInstance,
  engineHealth: EngineHealthService,
  engineUpdate?: EngineUpdateService,
): void {
  app.get("/engine/health", async () => engineHealth.health());

  app.post("/engine/self-test", async (req, reply) => {
    const result = await engineHealth.selfTest();
    return reply.code(result.ok ? 200 : 503).send(result);
  });

  if (engineUpdate) {
    app.get("/engine/update", async () => engineUpdate.check());
    app.post("/engine/update", async (_req, reply) => {
      const r = await engineUpdate.start();
      return reply.code(r.started ? 202 : 200).send(r);
    });
  }
}
