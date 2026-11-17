import type { FastifyInstance } from "fastify";
import type { EmailAccountService } from "../application/email/email-account.service.js";

/**
 * Email accounts for the IMAP resolver. Not a scripting surface: nothing
 * here runs code — it stores a mailbox address + app password (SecretStore,
 * write-only) and can test a login. No route ever returns the password.
 */
export function registerEmailAccountRoutes(app: FastifyInstance, accounts: EmailAccountService): void {
  app.get("/email-accounts", async () => ({ accounts: accounts.list() }));

  app.post("/email-accounts", async (req, reply) => {
    return reply.code(201).send(accounts.create((req.body ?? {}) as never));
  });

  app.delete("/email-accounts/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    accounts.delete(id);
    return reply.code(204).send();
  });

  app.post("/email-accounts/:id/test", async (req) => {
    const { id } = req.params as { id: string };
    return accounts.test(id);
  });
}
