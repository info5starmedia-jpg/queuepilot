import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { AgentEvent, AgentService } from "../application/agent/agent.service.js";
import { OllamaProvider, type ModelProvider } from "../application/agent/provider.js";
import { toHttpError } from "./error-mapper.js";

/**
 * P9 agent HTTP surface. Commands stream back as NDJSON (one AgentEvent per
 * line) so the console can show tokens, tool chips and confirmation prompts
 * as they happen. "/agent" is on the browser-origin deny list: a web page
 * inside a profile browser can never command the agent.
 */

const SendSchema = z.object({ text: z.string().min(1).max(4000) });
const ConfirmSchema = z.object({ pendingId: z.string().uuid(), approve: z.boolean() });

async function stream(reply: FastifyReply, run: (emit: (e: AgentEvent) => void) => Promise<void>): Promise<void> {
  reply.hijack();
  reply.raw.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" });
  const emit = (e: AgentEvent) => reply.raw.write(JSON.stringify(e) + "\n");
  try {
    await run(emit);
  } catch (err) {
    const { body } = toHttpError(err);
    emit({ type: "done", outcome: "error", reason: (body as { error?: { message?: string } }).error?.message ?? String(err) });
  } finally {
    reply.raw.end();
  }
}

export function registerAgentRoutes(app: FastifyInstance, agent: AgentService, providerFor: () => ModelProvider): void {
  app.get("/agent/status", async () => agent.status());

  // Download the configured model through Ollama (it can take minutes);
  // progress shows on /agent/status.pull.
  app.post("/agent/pull", async (_req, reply) => {
    const provider = providerFor();
    if (!(provider instanceof OllamaProvider)) return reply.code(400).send({ error: { code: "VALIDATION_FAILED", message: "only the local Ollama provider can pull models" } });
    if (agent.pullState && !agent.pullState.done) return reply.code(409).send({ error: { code: "CONFLICT", message: "a model download is already running" } });
    const model = (await provider.status()).model;
    agent.pullState = { model, status: "starting", done: false, error: null };
    const state = agent.pullState;
    void provider
      .pull((status, completed, total) => Object.assign(state, { status, completed, total }))
      .then(() => Object.assign(state, { status: "success", done: true }))
      .catch((err: unknown) => Object.assign(state, { done: true, error: err instanceof Error ? err.message : String(err) }));
    return reply.code(202).send({ pulling: model });
  });

  app.get("/agent/chats", async () => ({ chats: agent.listChats() }));
  app.post("/agent/chats", async (_req, reply) => reply.code(201).send(agent.createChat()));
  app.get("/agent/chats/:id", async (req) => agent.getChat((req.params as { id: string }).id));
  app.delete("/agent/chats/:id", async (req, reply) => {
    agent.deleteChat((req.params as { id: string }).id);
    return reply.code(204).send();
  });

  app.post("/agent/chats/:id/messages", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { text } = SendSchema.parse(req.body);
    agent.getChat(id); // 404 before the stream starts
    await stream(reply, (emit) => agent.send(id, text, emit));
  });

  app.post("/agent/chats/:id/confirm", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { pendingId, approve } = ConfirmSchema.parse(req.body);
    agent.getChat(id);
    await stream(reply, (emit) => agent.confirm(id, pendingId, approve, emit));
  });

  app.get("/agent/actions", async (req) => {
    const { limit } = req.query as { limit?: string };
    return { actions: agent.actions(limit ? Number(limit) : 100) };
  });
}
