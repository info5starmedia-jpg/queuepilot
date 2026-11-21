import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DomainError, ErrorCodes } from "@queuepilot/contracts";
import type { ChatMessage, ModelProvider, ProviderStatus, ToolCall } from "./provider.js";
import { scrubSecrets, toolSpecs, type AgentTool } from "./agent-tools.js";

/**
 * P9 agent core. A command is one user sentence; the loop sends the chat
 * (system prompt + history) and the tool catalog to the local model, runs
 * the tool calls it asks for, feeds the results back, and repeats until the
 * model answers in text — or a hard cap stops it (12 steps, 120 s), in which
 * case it says so in plain English.
 *
 * Guardrails live here, not in the model:
 * - only catalog tools exist; anything else is refused and logged;
 * - arguments are zod-validated before any tool runs;
 * - DESTRUCTIVE tools never run from the model's say-so: the loop parks the
 *   call as "pending", the console shows Approve/Decline, and only the
 *   human's answer (logged) executes or drops it;
 * - every tool result passes scrubSecrets() before the model sees it.
 * Everything is recorded in an append-only action log.
 */

export const AGENT_LIMITS = { maxSteps: 12, wallMs: 120_000, maxChats: 200 } as const;

export const SYSTEM_PROMPT = [
  "You are the QueuePilot operator assistant. QueuePilot runs anti-detect browser profiles on THIS machine. You help one operator by calling the tools you are given.",
  "What you can answer and do (always via tools):",
  "- How many profiles, proxies, proxy groups, warmup recipes or plugins there are, how many profiles are running right now, and which browser engine is installed — app_overview answers all of this in one call.",
  "- Details of any profile or proxy, proxy groups and proxy health, the open tabs of a running profile, and a running profile's exit IP and timezone.",
  "- Start and stop a profile's browser, create a profile, rename a profile or change its group, notes or tags.",
  "- Test a proxy, replay a warmup recipe on a profile, and turn an installed plugin on or off.",
  "- Delete a profile or a proxy, and install a browser engine update — these always ask the operator to approve in the console first.",
  "You cannot do anything else: there is no tool for cookies, passwords, payment details, email or the team server, so say so plainly if asked.",
  "Rules:",
  "- Use tools for every fact and every action. Never claim something happened unless a tool result says so.",
  "- Refer to profiles and proxies by their names.",
  "- Deleting profiles or proxies and installing engine updates need the operator's approval in the console; call the tool and the console will ask them. Do not ask for confirmation in text first.",
  "- You never see passwords, cookies or tokens and cannot reveal them. If asked for one, say plainly that you cannot access credentials.",
  "- If a tool fails, explain the error in one sentence and stop or try a sensible alternative.",
  "- For a question about counts or what exists, call app_overview first and answer from it; only list items when asked for the list.",
  "- Keep answers short and plain. When you have finished, reply with a brief summary of what was done.",
].join("\n");

export type AgentEvent =
  | { type: "token"; text: string }
  | { type: "tool_call"; id: string; tool: string; category: string; summary: string; args: Record<string, unknown> }
  | { type: "tool_result"; id: string; tool: string; ok: boolean; summary: string }
  | { type: "confirm"; pending: PendingAction }
  | { type: "message"; text: string }
  | { type: "done"; outcome: "answered" | "awaiting_confirmation" | "stopped" | "error"; reason?: string };

export interface PendingAction {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  summary: string;
  createdAt: string;
}

export interface StoredChat {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
  pending: PendingAction | null;
}

export interface ActionRecord {
  at: string;
  chatId: string;
  tool: string;
  category: string;
  args: unknown;
  outcome: "ok" | "error" | "refused" | "invalid" | "awaiting_confirmation" | "approved" | "declined" | "stopped";
  summary: string;
}

export class AgentService {
  private readonly dir: string;
  private readonly chatsDir: string;
  private readonly actionsFile: string;
  private readonly busy = new Set<string>();
  private readonly byName: Map<string, AgentTool>;
  pullState: { model: string; status: string; completed?: number; total?: number; done: boolean; error: string | null } | null = null;

  constructor(
    dataDir: string,
    private readonly tools: AgentTool[],
    private readonly providerFor: () => ModelProvider,
    private readonly limits: { maxSteps: number; wallMs: number; maxChats: number } = AGENT_LIMITS,
  ) {
    this.dir = path.join(dataDir, "agent");
    this.chatsDir = path.join(this.dir, "chats");
    this.actionsFile = path.join(this.dir, "actions.jsonl");
    fs.mkdirSync(this.chatsDir, { recursive: true });
    this.byName = new Map(tools.map((t) => [t.name, t]));
  }

  // ------------------------------------------------------------ status

  async status(): Promise<ProviderStatus & { limits: { maxSteps: number; wallMs: number; maxChats: number }; pull: AgentService["pullState"]; tools: number }> {
    let s: ProviderStatus;
    try {
      s = await this.providerFor().status();
    } catch (err) {
      s = { provider: "ollama", url: "", reachable: false, version: null, model: "", modelPresent: false, installedModels: [], error: err instanceof Error ? err.message : String(err) };
    }
    return { ...s, limits: this.limits, pull: this.pullState, tools: this.tools.length };
  }

  // ------------------------------------------------------------ chats

  private chatFile(id: string): string {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new DomainError(ErrorCodes.VALIDATION_FAILED, "bad chat id");
    return path.join(this.chatsDir, `${id}.json`);
  }

  createChat(): StoredChat {
    const now = new Date().toISOString();
    const chat: StoredChat = { id: randomUUID(), title: "New chat", createdAt: now, updatedAt: now, messages: [], pending: null };
    this.saveChat(chat);
    this.pruneChats();
    return chat;
  }

  getChat(id: string): StoredChat {
    const f = this.chatFile(id);
    if (!fs.existsSync(f)) throw new DomainError(ErrorCodes.AGENT_CHAT_NOT_FOUND, `chat ${id} not found`);
    return JSON.parse(fs.readFileSync(f, "utf8")) as StoredChat;
  }

  listChats(): Array<{ id: string; title: string; updatedAt: string; pending: boolean }> {
    return fs
      .readdirSync(this.chatsDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(fs.readFileSync(path.join(this.chatsDir, f), "utf8")) as StoredChat)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt, pending: c.pending !== null }));
  }

  deleteChat(id: string): void {
    fs.rmSync(this.chatFile(id), { force: true });
  }

  private saveChat(chat: StoredChat): void {
    chat.updatedAt = new Date().toISOString();
    const f = this.chatFile(chat.id);
    fs.writeFileSync(`${f}.tmp`, JSON.stringify(chat, null, 1));
    fs.renameSync(`${f}.tmp`, f);
  }

  /** Keep the newest maxChats conversations. */
  private pruneChats(): void {
    const files = fs
      .readdirSync(this.chatsDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => ({ f, t: fs.statSync(path.join(this.chatsDir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const { f } of files.slice(this.limits.maxChats)) fs.rmSync(path.join(this.chatsDir, f), { force: true });
  }

  // ------------------------------------------------------------ action log

  private log(rec: Omit<ActionRecord, "at">): void {
    const line: ActionRecord = { at: new Date().toISOString(), ...rec, args: scrubSecrets(rec.args) };
    fs.appendFileSync(this.actionsFile, JSON.stringify(line) + "\n");
  }

  actions(limit = 100): ActionRecord[] {
    if (!fs.existsSync(this.actionsFile)) return [];
    const lines = fs.readFileSync(this.actionsFile, "utf8").split("\n").filter(Boolean);
    return lines.slice(-Math.min(Math.max(limit, 1), 1000)).reverse().map((l) => JSON.parse(l) as ActionRecord);
  }

  // ------------------------------------------------------------ the loop

  /** Run one operator command. Events stream to `emit`; resolves when the loop ends. */
  async send(chatId: string, text: string, emit: (e: AgentEvent) => void): Promise<void> {
    const chat = this.getChat(chatId);
    if (chat.pending) {
      throw new DomainError(ErrorCodes.CONFLICT, "answer the pending confirmation first (approve or decline)");
    }
    if (!text.trim()) throw new DomainError(ErrorCodes.VALIDATION_FAILED, "empty message");
    if (chat.messages.length === 0) chat.title = text.trim().slice(0, 60);
    chat.messages.push({ role: "user", content: text.trim().slice(0, 4000) });
    await this.runLoop(chat, emit);
  }

  /** The human's answer to a pending destructive action; then the loop continues. */
  async confirm(chatId: string, pendingId: string, approve: boolean, emit: (e: AgentEvent) => void): Promise<void> {
    const chat = this.getChat(chatId);
    const p = chat.pending;
    if (!p || p.id !== pendingId) throw new DomainError(ErrorCodes.CONFLICT, "no such pending action (already answered?)");
    chat.pending = null;
    const tool = this.byName.get(p.tool)!;
    if (approve) {
      this.log({ chatId, tool: p.tool, category: tool.category, args: p.args, outcome: "approved", summary: `operator approved: ${p.summary}` });
      await this.execute(chat, tool, p.args, p.id, emit);
    } else {
      this.log({ chatId, tool: p.tool, category: tool.category, args: p.args, outcome: "declined", summary: `operator declined: ${p.summary}` });
      chat.messages.push({ role: "tool", toolName: p.tool, content: JSON.stringify({ declined: true, note: "The operator declined. Nothing was done." }) });
      emit({ type: "tool_result", id: p.id, tool: p.tool, ok: false, summary: "declined by the operator — nothing was done" });
    }
    await this.runLoop(chat, emit);
  }

  private async runLoop(chat: StoredChat, emit: (e: AgentEvent) => void): Promise<void> {
    if (this.busy.has(chat.id)) throw new DomainError(ErrorCodes.CONFLICT, "this chat is already working on a command");
    this.busy.add(chat.id);
    const started = Date.now();
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.limits.wallMs);
    const stop = (reason: string) => {
      chat.messages.push({ role: "assistant", content: reason });
      emit({ type: "message", text: reason });
      emit({ type: "done", outcome: "stopped", reason });
      this.log({ chatId: chat.id, tool: "-", category: "-", args: {}, outcome: "stopped", summary: reason });
    };
    try {
      const provider = this.providerFor();
      const specs = toolSpecs(this.tools);
      for (let step = 1; ; step++) {
        if (step > this.limits.maxSteps) {
          return stop(`I stopped because I reached the limit of ${this.limits.maxSteps} steps for one command. Here is where things stand — ask me to continue if you want more.`);
        }
        if (Date.now() - started > this.limits.wallMs) {
          return stop(`I stopped because the ${this.limits.wallMs / 1000}-second time limit for one command ran out.`);
        }
        let reply;
        try {
          reply = await provider.chat([{ role: "system", content: SYSTEM_PROMPT }, ...chat.messages], specs, {
            signal: abort.signal,
            onToken: (t) => emit({ type: "token", text: t }),
          });
        } catch (err) {
          if (abort.signal.aborted) {
            return stop(`I stopped because the ${this.limits.wallMs / 1000}-second time limit for one command ran out.`);
          }
          const reason = `I could not use the model: ${err instanceof Error ? err.message : String(err)}`;
          chat.messages.push({ role: "assistant", content: reason });
          emit({ type: "message", text: reason });
          emit({ type: "done", outcome: "error", reason });
          return;
        }
        if (reply.kind === "text") {
          chat.messages.push({ role: "assistant", content: reply.text });
          emit({ type: "message", text: reply.text });
          emit({ type: "done", outcome: "answered" });
          return;
        }
        chat.messages.push({ role: "assistant", content: reply.text, toolCalls: reply.calls });
        for (const call of reply.calls) {
          const parked = await this.handleCall(chat, call, emit);
          if (parked) {
            emit({ type: "done", outcome: "awaiting_confirmation" });
            return;
          }
        }
      }
    } finally {
      clearTimeout(timer);
      this.busy.delete(chat.id);
      this.saveChat(chat);
    }
  }

  /** Returns true when the call was parked for the operator's confirmation. */
  private async handleCall(chat: StoredChat, call: ToolCall, emit: (e: AgentEvent) => void): Promise<boolean> {
    const id = randomUUID();
    const tool = this.byName.get(call.name);
    if (!tool) {
      const msg = `There is no tool called "${call.name}". Only the listed tools exist.`;
      this.log({ chatId: chat.id, tool: call.name, category: "unknown", args: call.arguments, outcome: "refused", summary: msg });
      chat.messages.push({ role: "tool", toolName: call.name, content: JSON.stringify({ error: msg }) });
      emit({ type: "tool_result", id, tool: call.name, ok: false, summary: "refused: not a QueuePilot tool" });
      return false;
    }
    const parsed = tool.schema.safeParse(call.arguments ?? {});
    if (!parsed.success) {
      const msg = `invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(args)"} ${i.message}`).join("; ")}`;
      this.log({ chatId: chat.id, tool: tool.name, category: tool.category, args: call.arguments, outcome: "invalid", summary: msg });
      chat.messages.push({ role: "tool", toolName: tool.name, content: JSON.stringify({ error: msg }) });
      emit({ type: "tool_result", id, tool: tool.name, ok: false, summary: msg });
      return false;
    }
    const args = parsed.data as Record<string, unknown>;
    const summary = tool.describe(args);
    emit({ type: "tool_call", id, tool: tool.name, category: tool.category, summary, args: scrubSecrets(args) as Record<string, unknown> });
    if (tool.category === "destructive") {
      chat.pending = { id, tool: tool.name, args, summary, createdAt: new Date().toISOString() };
      this.log({ chatId: chat.id, tool: tool.name, category: tool.category, args, outcome: "awaiting_confirmation", summary: `asked the operator: ${summary}` });
      emit({ type: "confirm", pending: chat.pending });
      return true;
    }
    await this.execute(chat, tool, args, id, emit);
    return false;
  }

  private async execute(chat: StoredChat, tool: AgentTool, args: Record<string, unknown>, id: string, emit: (e: AgentEvent) => void): Promise<void> {
    try {
      const result = scrubSecrets(await tool.run(args));
      const content = JSON.stringify(result);
      chat.messages.push({ role: "tool", toolName: tool.name, content: content.length > 12_000 ? content.slice(0, 12_000) + "…(truncated)" : content });
      this.log({ chatId: chat.id, tool: tool.name, category: tool.category, args, outcome: "ok", summary: tool.describe(args) });
      emit({ type: "tool_result", id, tool: tool.name, ok: true, summary: tool.describe(args) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      chat.messages.push({ role: "tool", toolName: tool.name, content: JSON.stringify({ error: msg }) });
      this.log({ chatId: chat.id, tool: tool.name, category: tool.category, args, outcome: "error", summary: msg });
      emit({ type: "tool_result", id, tool: tool.name, ok: false, summary: msg });
    }
  }
}
