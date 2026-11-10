import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";

/**
 * The web dashboard: static assets served by the API itself (no separate
 * hosting, no build step, no CDN — the whole console ships in the repo and
 * works offline on loopback).
 *
 * Security notes: the allowlist of servable files comes from the directory
 * listing itself, path segments are rejected outright (no traversal), and the
 * dashboard honors the same bearer-token hook as every other route.
 */
const DASHBOARD_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "dashboard",
);

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function serveFile(file: string): { body: Buffer; type: string } | null {
  // No separators, no dotfiles, no traversal — flat allowlisted assets only.
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(file)) return null;
  const full = path.join(DASHBOARD_DIR, file);
  if (path.dirname(full) !== DASHBOARD_DIR) return null;
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return null;
  const type = CONTENT_TYPES[path.extname(full).toLowerCase()];
  if (!type) return null;
  return { body: fs.readFileSync(full), type };
}

export function registerDashboardRoutes(app: FastifyInstance): void {
  app.get("/", async (_req, reply) => {
    const index = serveFile("index.html");
    if (!index)
      return reply
        .code(404)
        .send({
          error: { code: "NOT_FOUND", message: "dashboard assets missing" },
        });
    return reply.type(index.type).send(index.body);
  });

  app.get("/dashboard/:file", async (req, reply) => {
    const { file } = req.params as { file: string };
    const asset = serveFile(file);
    if (!asset) {
      return reply
        .code(404)
        .send({
          error: {
            code: "NOT_FOUND",
            message: `dashboard asset ${file} not found`,
          },
        });
    }
    return reply.type(asset.type).send(asset.body);
  });
}
