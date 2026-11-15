import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { PERSONA_WELL_KNOWN_FIELDS } from "@queuepilot/contracts";
import type { PluginRegistry } from "../application/plugins/plugin-registry.js";
import type { ResolverRegistry, ResolverContext } from "../application/resolvers/resolver-registry.js";
import { resolveSiteField } from "../application/resolvers/resolver-registry.js";
import type { ParserRegistry } from "../application/parsers/parser-registry.js";
import type { AliasStore } from "../application/resolvers/token-aliases.js";
import type { ProfileService } from "../application/profiles/profile.service.js";
import {
  looksLikeSpec,
  personaFieldValue,
} from "../application/profiles/persona-fields.js";

export interface PluginDeps {
  plugins: PluginRegistry;
  resolvers: ResolverRegistry;
  parsers: ParserRegistry;
  aliases: AliasStore;
  profiles: ProfileService;
  /** Audit A-rec #3: throws unless scripting endpoints are opted in. */
  assertScriptingEnabled: () => void;
}

const RunResolverSchema = z.object({
  spec: z.string().min(1).max(2000),
  profileId: z.string().uuid().optional(),
});

const ResolveFieldSchema = z.object({
  /** Site column selector. Omit to resolve a well-known persona field. */
  site: z.string().min(1).max(200).optional(),
  field: z.string().min(1).max(60),
});

const RunParserSchema = z.object({
  subject: z.string().max(1000).default(""),
  from: z.string().max(500).default(""),
  body: z.string().max(200_000).default(""),
});

const AliasSchema = z.object({ secret: z.string().min(1).max(4000) });

export function registerPluginRoutes(app: FastifyInstance, deps: PluginDeps): void {
  const { plugins, resolvers, parsers, aliases, profiles, assertScriptingEnabled } = deps;

  app.get("/plugins", async () => ({ plugins: plugins.list() }));
  app.get("/plugins/logs", async () => ({ logs: plugins.recentLogs() }));
  app.post("/plugins/rescan", async () => {
    assertScriptingEnabled(); // loads new code from disk
    return plugins.rescan();
  });
  app.post("/plugins/:id/enable", async (req) => {
    const { id } = req.params as { id: string };
    const body = z.object({ enabled: z.boolean() }).parse(req.body ?? {});
    await plugins.setEnabled(id, body.enabled);
    return { id, enabled: body.enabled };
  });

  app.get("/resolvers", async () => ({ resolvers: resolvers.list() }));
  app.post("/resolvers/run", async (req) => {
    assertScriptingEnabled(); // runs resolver code; may return secret values
    const body = RunResolverSchema.parse(req.body);
    const ctx = resolverContext(body.profileId, profiles);
    const value = await resolvers.resolve(body.spec, ctx, aliases);
    return { spec: body.spec, value };
  });

  app.get("/parsers", async () => ({ parsers: parsers.list() }));
  app.post("/parsers/rescan", async () => {
    assertScriptingEnabled(); // loads new code from disk
    return parsers.rescan();
  });
  app.post("/parsers/:name/run", async (req) => {
    assertScriptingEnabled(); // runs parser code
    const { name } = req.params as { name: string };
    const body = RunParserSchema.parse(req.body ?? {});
    return parsers.run(name, body);
  });

  // Token aliases — secrets never leave the machine; routes only set/delete.
  app.put("/aliases/:alias", async (req) => {
    assertScriptingEnabled(); // writes secrets
    const { alias } = req.params as { alias: string };
    const body = AliasSchema.parse(req.body);
    aliases.set(alias, body.secret);
    return { alias };
  });
  app.delete("/aliases/:alias", async (req) => {
    assertScriptingEnabled();
    const { alias } = req.params as { alias: string };
    aliases.remove(alias);
    return { alias };
  });

  // Jancy's Site: columns — stored per profile in extra.sites, resolved here.
  // Without a site, a well-known persona field (password/smscode/emailcode/
  // othercode from extra.fields) resolves instead: a literal passes through,
  // a `name:args` value whose name is a REGISTERED resolver gets resolved.
  app.post("/profiles/:id/resolve", async (req) => {
    const { id } = req.params as { id: string };
    const body = ResolveFieldSchema.parse(req.body);
    const profile = profiles.get(id);
    const ctx = resolverContext(id, profiles);

    if (body.site) {
      const sites = (profile.extra?.sites ?? undefined) as
        | Record<string, string>
        | undefined;
      const out = await resolveSiteField(
        sites,
        body.site,
        body.field,
        ctx,
        resolvers,
        aliases,
      );
      if (out.found) return { ...out, profileId: id };
      // Fall through to the well-known field — a Site column that doesn't
      // name the field may still want the profile's global smscode, etc.
    }

    const wellKnown = PERSONA_WELL_KNOWN_FIELDS.find((f) => f === body.field);
    if (wellKnown) {
      const raw = personaFieldValue(profile.extra, wellKnown);
      if (raw !== null) {
        const registered = new Set(resolvers.list().map((r) => r.name));
        const value = looksLikeSpec(raw, registered)
          ? await resolvers.resolve(raw, { ...ctx, site: body.site, field: wellKnown }, aliases)
          : raw;
        return { found: true, field: wellKnown, value, spec: looksLikeSpec(raw, registered) ? raw : undefined, profileId: id };
      }
    }
    return { found: false, profileId: id };
  });
}

function resolverContext(
  profileId: string | undefined,
  profiles: ProfileService,
): ResolverContext {
  const email = profileId
    ? (profiles.get(profileId).email ?? undefined)
    : undefined;
  return { profileId, email };
}
