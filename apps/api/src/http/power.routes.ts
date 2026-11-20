import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { SETTINGS_SECTIONS, type Settings } from "@queuepilot/contracts";
import { COMMANDS, PresetStore, commandById, decodeTabString, encodeTabString, presetSafe } from "../application/power/power.js";
import type { NetworkLogger } from "../application/netlog/network-logger.js";

/**
 * J7 / J8 power-user routes. All browser-origin denied.
 *   GET  /commands                          the catalogue (id, title, args)
 *   POST /commands/run                      { command, profileIds, args? } → per-profile results
 *   GET  /presets · PUT/DELETE /presets/:name · POST /presets/:name/apply
 *   POST /settings/soft-reset               { confirm: true, sections? } forget stored settings
 *   GET/POST /profiles/:id/tab-string       generate / open a `qp1:` tab string
 *   POST /profiles/:id/netlog/start|stop · GET /profiles/:id/netlog
 */
export function registerPowerRoutes(
  app: FastifyInstance,
  deps: {
    presets: PresetStore;
    settings: { getAll(): Settings; patch(section: string, partial: unknown): unknown; reset(sections?: string[]): Settings };
    openUrls: (profileId: string) => string[];
    openTab: (profileId: string, url: string) => Promise<unknown>;
    netlog: NetworkLogger;
    wsEndpoint: (profileId: string) => string;
  },
): void {
  app.get("/commands", async () => ({ commands: COMMANDS.map(({ id, title, args }) => ({ id, title, args })) }));

  app.post("/commands/run", async (req) => {
    const b = z
      .object({ command: z.string().max(60), profileIds: z.array(z.string().uuid()).min(1).max(500), args: z.record(z.unknown()).default({}) })
      .strict()
      .parse(req.body ?? {});
    const def = commandById(b.command);
    const results: { profileId: string; ok: boolean; error?: string }[] = [];
    for (const profileId of b.profileIds) {
      const call = def.call(profileId, b.args);
      // Re-enter the app so the command goes through the same validation, hooks and token check as a direct call.
      const res = await app.inject({
        method: call.method,
        url: call.url,
        payload: call.body,
        headers: req.headers.authorization ? { authorization: req.headers.authorization } : {},
      });
      results.push(res.statusCode < 400 ? { profileId, ok: true } : { profileId, ok: false, error: (res.json() as { error?: { message?: string } }).error?.message ?? `HTTP ${res.statusCode}` });
    }
    return { results };
  });

  app.get("/presets", async () => ({ presets: deps.presets.list() }));
  const name = (req: { params: unknown }) => z.string().regex(/^[\w .-]{1,60}$/).parse((req.params as { name: string }).name);
  app.put("/presets/:name", async (req) => {
    deps.presets.save(name(req), deps.settings.getAll());
    return { saved: true, presets: deps.presets.list() };
  });
  app.delete("/presets/:name", async (req) => {
    deps.presets.delete(name(req));
    return { presets: deps.presets.list() };
  });
  app.post("/presets/:name/apply", async (req) => {
    const preset = deps.presets.get(name(req)) as Record<string, unknown>;
    for (const [section, value] of Object.entries(preset)) {
      if ((SETTINGS_SECTIONS as readonly string[]).includes(section)) deps.settings.patch(section, presetSafe(section, value));
    }
    return { applied: true };
  });

  app.post("/settings/soft-reset", async (req) => {
    const b = z.object({ confirm: z.literal(true), sections: z.array(z.string()).max(20).optional() }).strict().parse(req.body ?? {});
    return deps.settings.reset(b.sections);
  });

  app.get("/profiles/:id/tab-string", async (req) => ({ tabString: encodeTabString(deps.openUrls((req.params as { id: string }).id)) }));
  app.post("/profiles/:id/tab-string", async (req) => {
    const { tabString } = z.object({ tabString: z.string().max(200_000) }).strict().parse(req.body ?? {});
    const urls = decodeTabString(tabString);
    const id = (req.params as { id: string }).id;
    for (const u of urls) await deps.openTab(id, u);
    return { opened: urls.length };
  });

  app.get("/profiles/:id/netlog", async (req) => deps.netlog.status((req.params as { id: string }).id));
  app.post("/profiles/:id/netlog/start", async (req) => {
    const b = z
      .object({ mode: z.enum(["strip", "cookies", "everything"]).default("strip"), maxMb: z.number().min(1).max(500).default(50) })
      .strict()
      .parse(req.body ?? {});
    const id = (req.params as { id: string }).id;
    return deps.netlog.start(id, deps.wsEndpoint(id), { mode: b.mode, maxBytes: Math.floor(b.maxMb * 1024 * 1024) });
  });
  app.post("/profiles/:id/netlog/stop", async (req) => deps.netlog.stop((req.params as { id: string }).id));
}
