import type { FastifyInstance, FastifyReply } from "fastify";
import type { LifecycleEvent } from "@queuepilot/contracts";
import type { BrowserLifecycleService } from "../application/lifecycle/browser.lifecycle.service.js";

/**
 * Server-sent events stream for UIs and agents: one connection, every
 * lifecycle transition pushed as it happens. Dashboards poll nothing.
 */
export function registerEventRoutes(app: FastifyInstance, lifecycle: BrowserLifecycleService): void {
  const clients = new Set<FastifyReply>();

  lifecycle.events.on("lifecycle", (event: LifecycleEvent) => {
    const line = `data: ${JSON.stringify(event)}\n\n`;
    for (const reply of clients) {
      reply.raw.write(line);
    }
  });

  app.get("/events", (req, reply) => {
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      // v0.15.0 (audit A1): NO access-control-allow-origin here. The
      // dashboard is same-origin (served by this API), so it needs no CORS —
      // and a wildcard on a loopback event stream lets ANY website the
      // operator visits read lifecycle events via EventSource.
    });
    reply.raw.write(`data: ${JSON.stringify({ type: "profile.updated", profileId: "00000000-0000-0000-0000-000000000000", runId: null, at: new Date().toISOString(), detail: "connected" })}\n\n`);
    clients.add(reply);
    req.raw.on("close", () => clients.delete(reply));
    // We own the response now.
    return reply;
  });
}
