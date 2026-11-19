import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { DomainError, ErrorCodes } from "@queuepilot/contracts";
import type { AliasStore } from "../application/resolvers/token-aliases.js";
import { AYCD_KEY_ALIAS } from "../application/email/aycd-inbox.js";

/**
 * AYCD Inbox key slot (Settings → Integrations). The Inbox API key lives in
 * the encrypted SecretStore under the token alias `aycd`, so profile CSVs
 * reference it as `emailcode=aycd:@aycd` and the raw key never sits in a
 * file. Routes never return the key — only whether one is stored.
 * Same trust level as /email-accounts (which stores app passwords).
 */

const PutKeySchema = z.object({
  apiKey: z.string().trim().min(8).max(500).regex(/^\S+$/, "API key must not contain spaces"),
});

export interface AycdRouteDeps {
  aliases: AliasStore;
  verify(key: string): Promise<{ ok: boolean; error: string | null }>;
}

export function registerAycdRoutes(app: FastifyInstance, deps: AycdRouteDeps): void {
  const status = () => ({
    configured: deps.aliases.get(AYCD_KEY_ALIAS) !== null,
    alias: AYCD_KEY_ALIAS,
    usage: `emailcode=aycd:@${AYCD_KEY_ALIAS}`,
  });

  app.get("/integrations/aycd", async () => status());

  app.put("/integrations/aycd", async (req) => {
    const { apiKey } = PutKeySchema.parse(req.body);
    deps.aliases.set(AYCD_KEY_ALIAS, apiKey);
    return status();
  });

  app.delete("/integrations/aycd", async () => {
    deps.aliases.remove(AYCD_KEY_ALIAS);
    return status();
  });

  app.post("/integrations/aycd/verify", async () => {
    const key = deps.aliases.get(AYCD_KEY_ALIAS);
    if (!key) {
      throw new DomainError(ErrorCodes.VALIDATION_FAILED, "no AYCD Inbox API key stored yet");
    }
    return deps.verify(key);
  });
}
