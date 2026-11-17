import type { FastifyInstance, FastifyReply } from "fastify";
import type { LifecycleEvent } from "@queuepilot/contracts";
import type { BrowserLifecycleService } from "../application/lifecycle/browser.lifecycle.service.js";

/**
 * Server-sent events stream for UIs and agents: one connection, every
 * lifecycle transition pushed as it happens. Dashboards poll nothing.
 */
export function registerEventRoutes(app: FastifyInstance, lifecycle: BrowserLifecycleService): void {
  const clients = new Set<FastifyReply>();

  /**
   * Audit GPT-5.4 finding 5a: dead clients used to linger forever — a
   * closed dashboard tab stayed in the set and every lifecycle event
   * wrote into a dead socket. A reply is pruned when its underlying
   * response has ended or been destroyed.
   */
  const pruneDead = (): void => {
    for (const reply of clients) {
      if (reply.raw.destroyed || reply.raw.writableEnded) clients.delete(reply);
    }
  };

  lifecycle.events.on("lifecycle", (event: LifecycleEvent) => {
    pruneDead();
    const line = `data: ${JSON.stringify(event)}\n\n`;
    for (const reply of clients) {
      reply.raw.write(line);
    }
  });

  // Heartbeat every 30s: keeps intermediaries honest and doubles as the
  // slow prune sweep for quiet installs (no events → no broadcast prune).
  const heartbeat = setInterval(() => {
    pruneDead();
    for (const reply of clients) {
      reply.raw.write(`: ping\n\n`);
    }
  }, 30_000);
  app.addHook("onClose", async () => clearInterval(heartbeat));

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
