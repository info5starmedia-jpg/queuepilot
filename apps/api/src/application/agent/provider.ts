import { isLoopbackUrl } from "@queuepilot/contracts";

/**
 * P9 model provider layer. One interface — chat(messages, tools) returns
 * either tool calls or text — and ONE implementation: Ollama on this
 * machine. "cloud" is a reserved kind in the type so a future provider has
 * a slot; it has no implementation and createProvider refuses it. Nothing
 * here can talk to a non-loopback host (checked again at construction, on
 * top of the settings schema).
 */

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** Assistant turns that asked for tools. */
  toolCalls?: ToolCall[];
  /** Tool turns: which tool produced this result. */
  toolName?: string;
}

/** A tool as the model sees it: name, plain-language description, JSON Schema args. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type ProviderReply =
  | { kind: "tool_calls"; calls: ToolCall[]; text: string }
  | { kind: "text"; text: string };

export interface ProviderStatus {
  provider: ProviderKind;
  url: string;
  reachable: boolean;
  version: string | null;
  model: string;
  modelPresent: boolean;
  installedModels: string[];
  error: string | null;
}

export type ProviderKind = "ollama" | "cloud";

export interface ChatOptions {
  signal?: AbortSignal;
  /** Streaming text as it arrives (assistant content only). */
  onToken?: (text: string) => void;
}

export interface ModelProvider {
  readonly kind: ProviderKind;
  chat(messages: ChatMessage[], tools: ToolSpec[], opts?: ChatOptions): Promise<ProviderReply>;
  status(): Promise<ProviderStatus>;
}

export interface ProviderConfig {
  kind: ProviderKind;
  url: string;
  model: string;
}

export function createProvider(cfg: ProviderConfig, fetchImpl: typeof fetch = fetch): ModelProvider {
  if (cfg.kind === "cloud") {
    // Reserved slot (owner decision 2026-11-17): no cloud code paths exist.
    throw new Error("the cloud provider slot is reserved and not implemented — the agent runs on a local model");
  }
  return new OllamaProvider(cfg.url, cfg.model, fetchImpl);
}

interface OllamaChatChunk {
  message?: { role?: string; content?: string; tool_calls?: Array<{ function?: { name?: string; arguments?: unknown } }> };
  done?: boolean;
  error?: string;
}

export class OllamaProvider implements ModelProvider {
  readonly kind = "ollama" as const;

  constructor(
    private readonly url: string,
    private readonly model: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    if (!isLoopbackUrl(url)) throw new Error(`provider URL must be loopback, got ${url}`);
  }

  private endpoint(p: string): string {
    return this.url.replace(/\/+$/, "") + p;
  }

  async chat(messages: ChatMessage[], tools: ToolSpec[], opts: ChatOptions = {}): Promise<ProviderReply> {
    const res = await this.fetchImpl(this.endpoint("/api/chat"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: opts.signal ?? null,
      body: JSON.stringify({
        model: this.model,
        stream: true,
        // Deterministic-leaning: an operator's command should do the same thing twice.
        options: { temperature: 0 },
        messages: messages.map(toOllamaMessage),
        tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })),
      }),
    });
    if (res.status === 401) {
      throw new Error(`Ollama refused the model call (401): "${this.model}" needs the Ollama app signed in to ollama.com (run "ollama signin")`);
    }
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => "");
      throw new Error(`model call failed: HTTP ${res.status}${detail ? ` — ${detail.slice(0, 200)}` : ""}`);
    }
    let text = "";
    const calls: ToolCall[] = [];
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const chunk = JSON.parse(line) as OllamaChatChunk;
        if (chunk.error) throw new Error(`model error: ${chunk.error}`);
        const piece = chunk.message?.content ?? "";
        if (piece) {
          text += piece;
          opts.onToken?.(piece);
        }
        for (const tc of chunk.message?.tool_calls ?? []) {
          const name = tc.function?.name;
          if (!name) continue;
          calls.push({ name, arguments: normaliseArgs(tc.function?.arguments) });
        }
      }
    }
    return calls.length ? { kind: "tool_calls", calls, text } : { kind: "text", text };
  }

  async status(): Promise<ProviderStatus> {
    const base: ProviderStatus = {
      provider: "ollama",
      url: this.url,
      reachable: false,
      version: null,
      model: this.model,
      modelPresent: false,
      installedModels: [],
      error: null,
    };
    try {
      const v = await this.fetchImpl(this.endpoint("/api/version"), { signal: AbortSignal.timeout(3000) });
      if (!v.ok) return { ...base, error: `HTTP ${v.status} from ${this.url}` };
      const { version } = (await v.json()) as { version?: string };
      const t = await this.fetchImpl(this.endpoint("/api/tags"), { signal: AbortSignal.timeout(3000) });
      const { models } = (await t.json()) as { models?: Array<{ name: string }> };
      const installedModels = (models ?? []).map((m) => m.name);
      return {
        ...base,
        reachable: true,
        version: version ?? null,
        installedModels,
        modelPresent: installedModels.some((m) => m === this.model || m === `${this.model}:latest`),
      };
    } catch (err) {
      return { ...base, error: `not reachable at ${this.url}: ${err instanceof Error ? err.message : String(err)} — is Ollama installed and running?` };
    }
  }

  /** Ask Ollama to download the model; resolves when done. Progress via onProgress. */
  async pull(onProgress: (status: string, completed?: number, total?: number) => void, signal?: AbortSignal): Promise<void> {
    const res = await this.fetchImpl(this.endpoint("/api/pull"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: this.model, stream: true }),
      signal: signal ?? null,
    });
    if (!res.ok || !res.body) throw new Error(`pull failed: HTTP ${res.status}`);
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const c = JSON.parse(line) as { status?: string; completed?: number; total?: number; error?: string };
        if (c.error) throw new Error(`pull failed: ${c.error}`);
        onProgress(c.status ?? "", c.completed, c.total);
      }
    }
  }
}

function toOllamaMessage(m: ChatMessage): Record<string, unknown> {
  const out: Record<string, unknown> = { role: m.role, content: m.content };
  if (m.toolCalls?.length) out.tool_calls = m.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.arguments } }));
  if (m.role === "tool" && m.toolName) out.tool_name = m.toolName;
  return out;
}

/** Ollama returns arguments as an object; some models emit a JSON string. */
function normaliseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw === "string") {
    try {
      const v = JSON.parse(raw);
      if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
      /* fall through */
    }
  }
  return {};
}
