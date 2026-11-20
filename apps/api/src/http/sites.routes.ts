import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { DomainError, ErrorCodes } from "@queuepilot/contracts";
import type { BrowserLifecycleService } from "../application/lifecycle/browser.lifecycle.service.js";
import type { SitePluginService } from "../application/siteplugins/site-plugin.service.js";
import { decryptExport, type DiscordService } from "../application/discord/discord.service.js";
import { listCookies } from "../application/cookies/cookie-thinger.js";

/**
 * J6 — site plug-ins + Discord.
 *   GET    /queue-positions[?profileId]          the in-memory queue-position log
 *   GET    /integrations/discord                 { configured, webhook (masked) }
 *   PUT    /integrations/discord                 { webhookUrl }
 *   DELETE /integrations/discord
 *   POST   /integrations/discord/test            one test post
 *   POST   /profiles/:id/discord/export          { format?, password? } cookies + exit IP (opt-in)
 *   POST   /tools/cookie-export/decrypt          { file, password } → cookies
 * All browser-origin denied; the two cookie routes also need a token-configured install.
 */
export function registerSiteRoutes(
  app: FastifyInstance,
  deps: {
    sites?: SitePluginService;
    discord?: DiscordService;
    lifecycle: BrowserLifecycleService;
    rawCookieExportAllowed: boolean;
    profileName: (id: string) => string;
    proxyName: (profileId: string) => string | null;
  },
): void {
  const { sites, discord } = deps;
  if (sites) {
    app.get("/queue-positions", async (req) => {
      const { profileId } = z.object({ profileId: z.string().uuid().optional() }).parse(req.query ?? {});
      return { positions: sites.positions(profileId) };
    });
  }
  if (!discord) return;

  const needToken = (what: string) => {
    if (!deps.rawCookieExportAllowed) {
      throw new DomainError(ErrorCodes.FORBIDDEN, `${what} requires SPECTRA_API_TOKEN to be configured on this install`);
    }
  };

  app.get("/integrations/discord", async () => discord.status());
  app.put("/integrations/discord", { bodyLimit: 4096 }, async (req) => {
    const { webhookUrl } = z.object({ webhookUrl: z.string().max(400) }).strict().parse(req.body ?? {});
    return discord.setWebhook(webhookUrl);
  });
  app.delete("/integrations/discord", async () => {
    discord.clearWebhook();
    return discord.status();
  });
  app.post("/integrations/discord/test", async () => {
    await discord.test();
    return { sent: true };
  });

  app.post("/profiles/:id/discord/export", async (req) => {
    needToken("sending cookies to Discord");
    const { id } = req.params as { id: string };
    const body = z
      .object({ format: z.enum(["json", "netscape"]).default("json"), password: z.string().min(8).max(200).optional() })
      .strict()
      .parse(req.body ?? {});
    const run = deps.lifecycle.activeRun(id);
    if (!run || run.status !== "running" || !run.wsEndpoint) {
      throw new DomainError(ErrorCodes.PROFILE_NOT_RUNNING, "start the profile first — cookies are read from the running browser");
    }
    const cookies = await listCookies(run.wsEndpoint);
    return discord.exportCookies({
      profileName: deps.profileName(id),
      exitIp: deps.lifecycle.egressDiagnostics(id)?.egress?.exitIp ?? null,
      proxyName: deps.proxyName(id),
      cookies,
      format: body.format,
      password: body.password,
    });
  });

  app.post("/tools/cookie-export/decrypt", { bodyLimit: 8 * 1024 * 1024 }, async (req) => {
    needToken("decrypting a cookie export");
    const body = z.object({ file: z.unknown(), password: z.string().min(1).max(200) }).strict().parse(req.body ?? {});
    const text = decryptExport(body.file, body.password);
    try {
      return { cookies: JSON.parse(text) as unknown };
    } catch {
      return { netscape: text };
    }
  });
}
