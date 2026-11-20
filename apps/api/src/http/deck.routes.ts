import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DeckService } from "../application/deck/deck.service.js";

/**
 * ADR-0008 Profile Deck.
 *   GET    /deck                       { supported, open, tabs[] }
 *   POST   /deck/open                  open the container, adopt every running profile
 *   POST   /deck/profiles/:id/adopt    add one running profile as a tab
 *   POST   /deck/profiles/:id/select   show that tab
 *   DELETE /deck                       close the container (windows go back to normal)
 *   POST   /deck/group-taskbar         one taskbar group for all running profile windows
 * Browser-origin denied (they drive real windows).
 */
export function registerDeckRoutes(
  app: FastifyInstance,
  deps: { deck: DeckService; running: () => { id: string; pid: number | null }[] },
): void {
  const { deck } = deps;
  const idOf = (req: { params: unknown }) => z.object({ id: z.string().uuid() }).parse(req.params).id;
  app.get("/deck", async () => deck.status());
  app.post("/deck/open", async () => {
    deck.open(deps.running().map((r) => r.id));
    return deck.status();
  });
  app.post("/deck/profiles/:id/adopt", async (req) => {
    await deck.adopt(idOf(req));
    return deck.status();
  });
  app.post("/deck/profiles/:id/select", async (req) => {
    deck.select(idOf(req));
    return deck.status();
  });
  app.delete("/deck", async () => {
    deck.close();
    return deck.status();
  });
  app.post("/deck/group-taskbar", async () => deck.groupTaskbar(deps.running().flatMap((r) => (r.pid ? [r.pid] : []))));
}
