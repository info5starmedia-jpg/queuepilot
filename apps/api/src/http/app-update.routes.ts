import type { FastifyInstance } from "fastify";
import type { AppUpdateService } from "../application/update/app-update.service.js";

/**
 * Family-release app self-update. GET is free (a version check against the
 * GitHub release's latest.json); POST is consent-gated and ends with the API
 * spawning the detached swap helper and exiting — the reply must land before
 * the process dies. Browser-origin denied (they drive a real process exit).
 */
export function registerAppUpdateRoutes(app: FastifyInstance, svc: AppUpdateService): void {
  app.get("/app/update", async () => svc.check());
  app.post("/app/update", async () => await svc.start());
}
