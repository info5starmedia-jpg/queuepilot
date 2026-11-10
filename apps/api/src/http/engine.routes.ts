import type { FastifyInstance } from "fastify";
import type { EngineHealthService } from "../application/engine/engine-health.service.js";

/**
 * Engine pre-flight endpoints. /engine/health is cheap and safe to poll;
 * /engine/self-test actually spawns a throwaway browser, so it is POST-only
 * and expected to be called on demand, not scraped.
 */
export function registerEngineRoutes(
  app: FastifyInstance,
  engineHealth: EngineHealthService,
): void {
  app.get("/engine/health", async () => engineHealth.health());

  app.post("/engine/self-test", async (req, reply) => {
    const result = await engineHealth.selfTest();
    return reply.code(result.ok ? 200 : 503).send(result);
  });
}
