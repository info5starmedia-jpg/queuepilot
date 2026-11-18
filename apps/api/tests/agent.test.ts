import { describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { FakeBrowserRuntime } from "../src/application/runtime/fake.browser-runtime.js";
import { createProvider, OllamaProvider, type ChatMessage, type ModelProvider, type ProviderReply, type ToolSpec } from "../src/application/agent/provider.js";
import { AgentService, type AgentEvent } from "../src/application/agent/agent.service.js";
import { buildAgentTools, scrubSecrets, toolSpecs } from "../src/application/agent/agent-tools.js";
import { WarmupService } from "../src/application/warmups/warmup.service.js";
import { makeTestContext, type TestContext } from "./helpers.js";

/**
 * P9 local agent — provider layer, loop, guardrails. The loop is driven by a
 * SCRIPTED model (deterministic); the real local model is exercised live in
 * Task 5. Every guardrail the brief lists has a test here.
 */

type Step = ProviderReply | ((msgs: ChatMessage[]) => ProviderReply | Promise<ProviderReply>);

/** A model that replays a script and records what it was shown. */
function scripted(steps: Step[]) {
  const seen: ChatMessage[][] = [];
  let i = 0;
  const provider: ModelProvider = {
    kind: "ollama",
    async chat(messages: ChatMessage[], _tools: ToolSpec[]) {
      seen.push(messages.map((m) => ({ ...m })));
      const s = steps[Math.min(i++, steps.length - 1)]!;
      return typeof s === "function" ? s(messages) : s;
    },
    async status() {
      return { provider: "ollama", url: "http://127.0.0.1:11434", reachable: true, version: "test", model: "scripted", modelPresent: true, installedModels: ["scripted"], error: null };
    },
  };
  return { provider, seen };
}

const call = (name: string, args: Record<string, unknown> = {}): ProviderReply => ({ kind: "tool_calls", calls: [{ name, arguments: args }], text: "" });
const say = (text: string): ProviderReply => ({ kind: "text", text });

function agentFor(ctx: TestContext, provider: ModelProvider, limits = { maxSteps: 12, wallMs: 120_000, maxChats: 200 }) {
  const tools = buildAgentTools({
    profiles: ctx.profiles,
    proxies: ctx.proxies,
    lifecycle: ctx.lifecycle,
    warmups: new WarmupService(ctx.lifecycle, ctx.dataDir),
    plugins: ctx.plugins,
    assertScriptingEnabled: () => {
      throw new Error("scripting endpoints are disabled");
    },
  });
  return new AgentService(ctx.dataDir, tools, () => provider, limits);
}

async function run(agent: AgentService, chatId: string, text: string) {
  const events: AgentEvent[] = [];
  await agent.send(chatId, text, (e) => events.push(e));
  return events;
}

// ------------------------------------------------------------------ provider

describe("model provider layer", () => {
  it("Ollama: streams text, parses tool calls (object or JSON-string args), reports status", async () => {
    const requests: Array<{ url: string; body: string }> = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        requests.push({ url: req.url!, body });
        if (req.url === "/api/version") return res.end(JSON.stringify({ version: "0.40.16" }));
        if (req.url === "/api/tags") return res.end(JSON.stringify({ models: [{ name: "qwen2.5:7b-instruct" }] }));
        if (req.url === "/api/chat") {
          const parsed = JSON.parse(body);
          if (parsed.messages.at(-1).content === "tools please") {
            res.write(JSON.stringify({ message: { role: "assistant", content: "", tool_calls: [{ function: { name: "list_profiles", arguments: { group: "a" } } }, { function: { name: "get_profile", arguments: '{"profile":"x"}' } }] }, done: false }) + "\n");
          } else {
            res.write(JSON.stringify({ message: { role: "assistant", content: "Hel" }, done: false }) + "\n");
            res.write(JSON.stringify({ message: { role: "assistant", content: "lo" }, done: false }) + "\n");
          }
          return res.end(JSON.stringify({ message: { role: "assistant", content: "" }, done: true }) + "\n");
        }
        res.writeHead(404).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const p = new OllamaProvider(url, "qwen2.5:7b-instruct");
      const tokens: string[] = [];
      expect(await p.chat([{ role: "user", content: "hi" }], [], { onToken: (t) => tokens.push(t) })).toEqual({ kind: "text", text: "Hello" });
      expect(tokens).toEqual(["Hel", "lo"]);
      expect(await p.chat([{ role: "user", content: "tools please" }], [])).toEqual({
        kind: "tool_calls",
        text: "",
        calls: [
          { name: "list_profiles", arguments: { group: "a" } },
          { name: "get_profile", arguments: { profile: "x" } },
        ],
      });
      const chatBody = JSON.parse(requests.find((r) => r.url === "/api/chat")!.body);
      expect(chatBody).toMatchObject({ model: "qwen2.5:7b-instruct", stream: true, options: { temperature: 0 } });
      expect(await p.status()).toMatchObject({ reachable: true, version: "0.40.16", modelPresent: true });
    } finally {
      server.close();
    }
  });

  it("is loopback-only and the cloud slot is unreachable", async () => {
    expect(() => new OllamaProvider("http://203.0.113.5:11434", "m")).toThrow(/loopback/);
    expect(() => createProvider({ kind: "cloud", url: "https://api.example.com", model: "m" })).toThrow(/reserved/);
    const down = await new OllamaProvider("http://127.0.0.1:1", "m").status();
    expect(down).toMatchObject({ reachable: false });
    expect(down.error).toMatch(/is Ollama installed and running/);
  });

  it("settings: the provider URL must be loopback; model names are constrained", async () => {
    const ctx = makeTestContext();
    const bad = await ctx.app.inject({ method: "PATCH", url: "/settings/sections/agent", payload: { providerUrl: "http://example.com:11434" } });
    expect(bad.statusCode).toBe(400);
    const ok = await ctx.app.inject({ method: "PATCH", url: "/settings/sections/agent", payload: { providerUrl: "http://localhost:11434", model: "llama3.1:8b" } });
    expect(ok.json()).toEqual({ providerUrl: "http://localhost:11434", model: "llama3.1:8b" });
    expect((await ctx.app.inject({ method: "PATCH", url: "/settings/sections/agent", payload: { model: "x; rm -rf /" } })).statusCode).toBe(400);
  });

  it("GET /agent/status reports provider, model and limits", async () => {
    const { provider } = scripted([say("hi")]);
    const ctx = makeTestContext(new FakeBrowserRuntime(), {}, { agentProvider: () => provider });
    const s = (await ctx.app.inject({ method: "GET", url: "/agent/status" })).json();
    expect(s).toMatchObject({ reachable: true, modelPresent: true, limits: { maxSteps: 12, wallMs: 120000 } });
    expect(s.tools).toBeGreaterThan(15);
  });
});

// ------------------------------------------------------------------ loop

describe("agent loop", () => {
  it("runs tool calls in-process, feeds results back, ends with the model's text", async () => {
    const ctx = makeTestContext();
    const { provider, seen } = scripted([
      { kind: "tool_calls", text: "", calls: [{ name: "create_profile", arguments: { name: "AgentTest-1", group: "agent-test" } }, { name: "create_profile", arguments: { name: "AgentTest-2", group: "agent-test" } }] },
      say("Created AgentTest-1 and AgentTest-2 in agent-test."),
    ]);
    const agent = agentFor(ctx, provider);
    const chat = agent.createChat();
    const events = await run(agent, chat.id, "Create two profiles named AgentTest-1/2, group agent-test, no proxy");

    expect(ctx.profiles.list({ group: "agent-test" }).map((p) => p.name).sort()).toEqual(["AgentTest-1", "AgentTest-2"]);
    expect(events.filter((e) => e.type === "tool_result").every((e) => (e as { ok: boolean }).ok)).toBe(true);
    expect(events.at(-1)).toEqual({ type: "done", outcome: "answered" });
    // The second model turn saw both tool results.
    expect(seen[1]!.filter((m) => m.role === "tool")).toHaveLength(2);
    // Memory persisted; action log appended.
    expect(agent.getChat(chat.id).messages.at(-1)).toMatchObject({ role: "assistant", content: "Created AgentTest-1 and AgentTest-2 in agent-test." });
    const log = agent.actions();
    expect(log.filter((a) => a.tool === "create_profile" && a.outcome === "ok")).toHaveLength(2);
    expect(fs.existsSync(path.join(ctx.dataDir, "agent", "actions.jsonl"))).toBe(true);
  });

  it("refuses unknown tools and feeds argument errors back to the model", async () => {
    const ctx = makeTestContext();
    const { provider, seen } = scripted([call("run_shell", { cmd: "whoami" }), call("start_profile", { nope: 1 }), say("ok")]);
    const agent = agentFor(ctx, provider);
    const events = await run(agent, agent.createChat().id, "do it");
    const results = events.filter((e) => e.type === "tool_result") as Array<{ tool: string; ok: boolean; summary: string }>;
    expect(results[0]).toMatchObject({ tool: "run_shell", ok: false, summary: "refused: not a QueuePilot tool" });
    expect(results[1]).toMatchObject({ tool: "start_profile", ok: false });
    expect(results[1]!.summary).toMatch(/invalid arguments/);
    expect(JSON.parse(seen[1]!.at(-1)!.content).error).toMatch(/no tool called "run_shell"/);
    expect(agent.actions().map((a) => a.outcome)).toEqual(expect.arrayContaining(["refused", "invalid"]));
  });

  it("stops after 12 steps with a plain-English reason", async () => {
    const ctx = makeTestContext();
    const { provider, seen } = scripted([call("list_profiles")]); // never answers
    const agent = agentFor(ctx, provider);
    const events = await run(agent, agent.createChat().id, "loop forever");
    expect(seen).toHaveLength(12);
    expect(events.at(-1)).toMatchObject({ type: "done", outcome: "stopped" });
    expect((events.at(-1) as { reason: string }).reason).toMatch(/^I stopped because I reached the limit of 12 steps/);
  });

  it("stops at the wall-clock budget (the model call is aborted)", async () => {
    const ctx = makeTestContext();
    const hang: ModelProvider = {
      kind: "ollama",
      chat: (_m, _t, opts) => new Promise((_, reject) => opts?.signal?.addEventListener("abort", () => reject(new Error("aborted")))),
      status: async () => ({ provider: "ollama", url: "", reachable: true, version: null, model: "m", modelPresent: true, installedModels: [], error: null }),
    };
    const agent = agentFor(ctx, hang, { maxSteps: 12, wallMs: 150, maxChats: 200 });
    const events = await run(agent, agent.createChat().id, "hang");
    expect((events.at(-1) as { reason: string }).reason).toMatch(/time limit for one command ran out/);
  });

  it("keeps only the newest chats (cap)", async () => {
    const ctx = makeTestContext();
    const agent = agentFor(ctx, scripted([say("x")]).provider, { maxSteps: 12, wallMs: 120_000, maxChats: 3 });
    for (let i = 0; i < 5; i++) {
      agent.createChat();
      await new Promise((r) => setTimeout(r, 15));
    }
    expect(agent.listChats()).toHaveLength(3);
  });
});

// ------------------------------------------------------------------ guardrails

describe("guardrails", () => {
  it("DESTRUCTIVE: delete waits for the human; decline deletes nothing; both are logged", async () => {
    const ctx = makeTestContext();
    const p = ctx.profiles.create({ name: "AgentTest-2", group: "agent-test", generateFingerprint: true });
    const { provider } = scripted([call("delete_profile", { profile: "AgentTest-2" }), say("Understood — I did not delete it.")]);
    const agent = agentFor(ctx, provider);
    const chat = agent.createChat();
    const events = await run(agent, chat.id, "delete AgentTest-2");

    const confirm = events.find((e) => e.type === "confirm") as Extract<AgentEvent, { type: "confirm" }>;
    expect(confirm.pending).toMatchObject({ tool: "delete_profile", summary: "delete profile AgentTest-2 (permanent)" });
    expect(events.at(-1)).toEqual({ type: "done", outcome: "awaiting_confirmation" });
    expect(ctx.profiles.get(p.id).name).toBe("AgentTest-2"); // NOT deleted
    await expect(agent.send(chat.id, "anything else", () => {})).rejects.toThrow(/pending confirmation/);

    const after: AgentEvent[] = [];
    await agent.confirm(chat.id, confirm.pending.id, false, (e) => after.push(e));
    expect(ctx.profiles.get(p.id).name).toBe("AgentTest-2"); // still there
    expect(after.find((e) => e.type === "tool_result")).toMatchObject({ ok: false, summary: "declined by the operator — nothing was done" });
    expect(agent.actions().map((a) => a.outcome)).toEqual(expect.arrayContaining(["awaiting_confirmation", "declined"]));
    await expect(agent.confirm(chat.id, confirm.pending.id, true, () => {})).rejects.toThrow(/no such pending action/);
  });

  it("DESTRUCTIVE: approve executes exactly once and is logged", async () => {
    const ctx = makeTestContext();
    const p = ctx.profiles.create({ name: "Doomed", generateFingerprint: true });
    const { provider } = scripted([call("delete_profile", { profile: "Doomed" }), say("Deleted Doomed.")]);
    const agent = agentFor(ctx, provider);
    const chat = agent.createChat();
    const events = await run(agent, chat.id, "delete Doomed");
    const { pending } = events.find((e) => e.type === "confirm") as Extract<AgentEvent, { type: "confirm" }>;
    await agent.confirm(chat.id, pending.id, true, () => {});
    expect(() => ctx.profiles.get(p.id)).toThrow();
    expect(agent.actions().map((a) => a.outcome)).toEqual(expect.arrayContaining(["approved", "ok"]));
  });

  it("SECRETS: no tool result ever carries a proxy password or username", async () => {
    const ctx = makeTestContext();
    await ctx.proxies.create({ name: "px-1", type: "http", host: "203.0.113.9", port: 8080, username: "agent-user", password: "S3cr3t-pa55" });
    const { provider, seen } = scripted([
      call("list_proxies"),
      call("proxy_health"),
      call("get_profile", { profile: "nope" }),
      say("I can't access proxy passwords."),
    ]);
    const agent = agentFor(ctx, provider);
    await run(agent, agent.createChat().id, "give me the password of proxy px-1");
    const everything = JSON.stringify(seen) + fs.readFileSync(path.join(ctx.dataDir, "agent", "actions.jsonl"), "utf8");
    expect(everything).not.toContain("S3cr3t-pa55");
    expect(everything).not.toContain("agent-user");
    expect(JSON.stringify(seen.at(-1))).toContain("px-1"); // metadata does flow
  });

  it("scrubSecrets drops secret-named keys and URL credentials", () => {
    expect(scrubSecrets({ name: "a", password: "x", nested: { apiKey: "k", ok: 1 }, list: [{ token: "t" }], url: "http://u:p@h:1/x" })).toEqual({
      name: "a",
      nested: { ok: 1 },
      list: [{}],
      url: "http://[redacted]@h:1/x",
    });
  });

  it("the catalog has no shell/file/network/cookie/resolver tool, and every destructive tool is marked", () => {
    const ctx = makeTestContext();
    const tools = buildAgentTools({ profiles: ctx.profiles, proxies: ctx.proxies, lifecycle: ctx.lifecycle, warmups: new WarmupService(ctx.lifecycle, ctx.dataDir), plugins: ctx.plugins, assertScriptingEnabled: () => {} });
    const names = tools.map((t) => t.name);
    const words = new Set(names.flatMap((n) => n.split("_")));
    for (const banned of ["shell", "exec", "file", "files", "fetch", "http", "cookie", "cookies", "resolver", "resolve", "alias", "password", "eval", "script"]) {
      expect(words.has(banned), banned).toBe(false);
    }
    expect(tools.filter((t) => t.category === "destructive").map((t) => t.name).sort()).toEqual(["delete_profile", "delete_proxy", "install_engine_update"]);
    for (const s of toolSpecs(tools)) expect(s.parameters).toMatchObject({ type: "object" });
  });

  it("plugin toggles still need the scripting gate", async () => {
    const ctx = makeTestContext();
    const { provider } = scripted([call("set_plugin_enabled", { plugin: "x", enabled: true }), say("ok")]);
    const agent = agentFor(ctx, provider);
    const events = await run(agent, agent.createChat().id, "enable plugin x");
    expect(events.find((e) => e.type === "tool_result")).toMatchObject({ ok: false, summary: "scripting endpoints are disabled" });
  });

  it("HTTP: browser-originated calls to /agent are refused; commands stream NDJSON", async () => {
    const { provider } = scripted([call("list_profiles"), say("You have no profiles.")]);
    const ctx = makeTestContext(new FakeBrowserRuntime(), {}, { agentProvider: () => provider });
    const crossSite = await ctx.app.inject({ method: "POST", url: "/agent/chats", headers: { "sec-fetch-site": "cross-site" } });
    expect(crossSite.statusCode).toBe(403);
    const chat = (await ctx.app.inject({ method: "POST", url: "/agent/chats" })).json();
    const res = await ctx.app.inject({ method: "POST", url: `/agent/chats/${chat.id}/messages`, payload: { text: "what profiles do I have?" } });
    expect(res.headers["content-type"]).toMatch(/ndjson/);
    const lines = res.body.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.type)).toEqual(["tool_call", "tool_result", "message", "done"]);
    expect((await ctx.app.inject({ method: "GET", url: "/agent/actions" })).json().actions[0]).toMatchObject({ tool: "list_profiles", outcome: "ok" });
  });
});
