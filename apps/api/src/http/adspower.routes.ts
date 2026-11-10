import type { FastifyInstance } from "fastify";
import { adsErr, adsOk, type AdsPowerStartData } from "@queuepilot/contracts";
import type { BrowserLifecycleService } from "../application/lifecycle/browser.lifecycle.service.js";
import type { ProfileService } from "../application/profiles/profile.service.js";

/**
 * AdsPower-compatible Local API. Existing tooling speaks to
 * http://127.0.0.1:50325/api/v1/... with the AdsPower envelope
 * ({ code: 0, msg: "success", data }). We answer in kind, so switching a
 * script from AdsPower to QueuePilot is a config-free operation.
 *
 * Errors use the AdsPower convention too (code != 0, message in msg) rather
 * than HTTP status codes, because that is what the tooling parses.
 */
export function registerAdsPowerRoutes(
  app: FastifyInstance,
  lifecycle: BrowserLifecycleService,
  profiles: ProfileService,
): void {
  app.get("/status", async () =>
    adsOk({ service: "queuepilot", version: "0.8.0" }),
  );

  app.post("/api/v1/browser/start", async (req, reply) => {
    const { profile_id } = (req.body ?? req.query) as { profile_id?: string };
    if (!profile_id) return reply.send(adsErr("profile_id is required"));
    try {
      const run = await lifecycle.start(profile_id);
      const data: AdsPowerStartData = {
        ws: {
          puppeteer: run.wsEndpoint ?? "",
          selenium: run.wsEndpoint ?? "",
        },
        debug_port: String(run.debugPort ?? ""),
      };
      return reply.send(adsOk(data));
    } catch (err) {
      return reply.send(
        adsErr(err instanceof Error ? err.message : String(err)),
      );
    }
  });

  app.get("/api/v1/browser/start", async (req, reply) => {
    // AdsPower's API accepts GET as well; mirror it for compatibility.
    const { profile_id } = req.query as { profile_id?: string };
    if (!profile_id) return reply.send(adsErr("profile_id is required"));
    try {
      const run = await lifecycle.start(profile_id);
      return reply.send(
        adsOk({
          ws: {
            puppeteer: run.wsEndpoint ?? "",
            selenium: run.wsEndpoint ?? "",
          },
          debug_port: String(run.debugPort ?? ""),
        }),
      );
    } catch (err) {
      return reply.send(
        adsErr(err instanceof Error ? err.message : String(err)),
      );
    }
  });

  app.all("/api/v1/browser/stop", async (req, reply) => {
    const src = {
      ...(req.query as object),
      ...((req.body ?? {}) as object),
    } as {
      profile_id?: string;
    };
    if (!src.profile_id) return reply.send(adsErr("profile_id is required"));
    try {
      const run = await lifecycle.stop(src.profile_id);
      return reply.send(adsOk({ stopped: run !== null }));
    } catch (err) {
      return reply.send(
        adsErr(err instanceof Error ? err.message : String(err)),
      );
    }
  });

  app.get("/api/v1/browser/active", async (req, reply) => {
    const { profile_id } = req.query as { profile_id?: string };
    if (!profile_id) return reply.send(adsErr("profile_id is required"));
    const run = lifecycle.activeRun(profile_id);
    return reply.send(
      adsOk({
        status: run ? "Active" : "Inactive",
        ws: run?.wsEndpoint
          ? { puppeteer: run.wsEndpoint, selenium: run.wsEndpoint }
          : undefined,
        debug_port: run?.debugPort ? String(run.debugPort) : undefined,
      }),
    );
  });

  app.get("/api/v1/profile/list", async (req, reply) => {
    const q = req.query as {
      group_id?: string;
      page?: string;
      page_size?: string;
    };
    const all = profiles.list(q.group_id ? { group: q.group_id } : {});
    const page = Math.max(1, Number(q.page ?? 1) || 1);
    const pageSize = Math.min(
      100,
      Math.max(1, Number(q.page_size ?? 50) || 50),
    );
    const slice = all.slice((page - 1) * pageSize, page * pageSize);
    return reply.send(
      adsOk({
        list: slice.map((p) => ({
          profile_id: p.id,
          user_id: p.id,
          name: p.name,
          group_id: p.group,
          created_time: p.createdAt,
        })),
      }),
    );
  });

  app.post("/api/v1/profile/create", async (req, reply) => {
    const body = (req.body ?? {}) as { name?: string; group_id?: string };
    if (!body.name) return reply.send(adsErr("name is required"));
    try {
      const p = profiles.create({
        name: body.name,
        group: body.group_id,
        generateFingerprint: true,
      });
      return reply.send(adsOk({ profile_id: p.id, user_id: p.id }));
    } catch (err) {
      return reply.send(
        adsErr(err instanceof Error ? err.message : String(err)),
      );
    }
  });
}
