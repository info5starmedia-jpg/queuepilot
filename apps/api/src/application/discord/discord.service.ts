import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import type { LifecycleEvent, Profile, SitesSettings } from "@queuepilot/contracts";
import { DomainError, ErrorCodes } from "@queuepilot/contracts";
import type { SecretStore } from "../secrets/secret-store.js";

/**
 * J6.5 — Discord (owner decision Q16: notifications + an opt-in cookie and
 * exit-IP export, nothing else). Send-only webhook:
 * - the webhook URL is a secret: it lives in the SecretStore, is masked in
 *   every response and is never logged;
 * - only discord.com webhook URLs are accepted, redirects are refused;
 * - posts are queued ≥ 2.1 s apart (Discord allows ~30/min per webhook) and
 *   a 429 waits out `retry_after` once;
 * - the cookie export is OFF unless the operator opts in, needs the same
 *   token-configured install as raw cookie export, and can be encrypted
 *   with a password (scrypt + AES-256-GCM) before it leaves the machine.
 */

export const DISCORD_WEBHOOK_KEY = "integration.discord.webhook";

const WEBHOOK = /^\/api\/webhooks\/(\d{5,25})\/[\w-]{20,200}$/;
const HOSTS = new Set(["discord.com", "discordapp.com", "ptb.discord.com", "canary.discord.com"]);

/** Accepts only a plain Discord webhook URL (no credentials, query or fragment). */
export function isDiscordWebhook(v: string): boolean {
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return false;
  }
  return u.protocol === "https:" && HOSTS.has(u.hostname) && !u.port && !u.username && !u.password && !u.search && !u.hash && WEBHOOK.test(u.pathname);
}

/** "discord.com/api/webhooks/1545…111/****" — enough to recognise, useless to abuse. */
export function maskWebhook(v: string): string {
  const m = WEBHOOK.exec(new URL(v).pathname);
  const id = m?.[1] ?? "";
  return `${new URL(v).hostname}/api/webhooks/${id.slice(0, 4)}…${id.slice(-3)}/****`;
}

export interface DiscordDeps {
  secrets: SecretStore;
  settings: () => SitesSettings;
  profiles: { get(id: string): Profile };
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface Outgoing {
  content: string;
  file?: { name: string; body: Buffer };
}

const LABELS: Record<string, string> = {
  "queue.passed": "✅ Queue passed",
  "queue.position": "🔢 Queue position",
  "cart.timer": "🛒 In cart",
  "code.resolved": "🔑 Code resolved",
  "code.failed": "⚠️ Code failed",
  "run.started": "▶️ Profile launched",
  "run.crashed": "💥 Profile crashed",
};

export class DiscordService {
  private readonly queue: Outgoing[] = [];
  private sending = false;
  private lastSentAt = 0;
  private readonly lastPositionAt = new Map<string, number>();

  constructor(private readonly deps: DiscordDeps) {}

  status(): { configured: boolean; webhook: string | null } {
    const url = this.deps.secrets.get(DISCORD_WEBHOOK_KEY);
    return { configured: url !== null, webhook: url ? maskWebhook(url) : null };
  }

  setWebhook(url: unknown): { configured: true; webhook: string } {
    if (typeof url !== "string" || !isDiscordWebhook(url.trim())) {
      throw new DomainError(ErrorCodes.VALIDATION_FAILED, "not a Discord webhook URL (https://discord.com/api/webhooks/<id>/<token>)");
    }
    this.deps.secrets.set(DISCORD_WEBHOOK_KEY, url.trim());
    return { configured: true, webhook: maskWebhook(url.trim()) };
  }

  clearWebhook(): void {
    this.deps.secrets.delete(DISCORD_WEBHOOK_KEY);
  }

  /** Lifecycle / site events → Discord, per the operator's event list. */
  onEvent(e: LifecycleEvent): void {
    const s = this.deps.settings();
    if (!s.discordEnabled || !(s.discordEvents as string[]).includes(e.type) || !this.status().configured) return;
    const now = (this.deps.now ?? Date.now)();
    if (e.type === "queue.position") {
      if (s.discordPositionEveryMin === 0) return;
      const last = this.lastPositionAt.get(e.profileId) ?? 0;
      if (now - last < s.discordPositionEveryMin * 60_000) return;
      this.lastPositionAt.set(e.profileId, now);
    }
    let who = "a profile";
    try {
      const p = this.deps.profiles.get(e.profileId);
      who = p.email ? `${p.name} (${p.email})` : p.name;
    } catch {
      /* deleted meanwhile */
    }
    this.enqueue({ content: clip(`**${LABELS[e.type] ?? e.type}** · ${who}${e.detail ? ` · ${e.detail}` : ""}`) });
  }

  /** A one-off test post (explicit operator action). */
  async test(): Promise<void> {
    await this.sendNow({ content: "QueuePilot test message: Discord notifications are connected." });
  }

  /**
   * Opt-in export: the profile's cookies + exit IP + proxy name as a file.
   * With a password the file is encrypted (decrypt with decryptCookieExport).
   */
  async exportCookies(args: {
    profileName: string;
    exitIp: string | null;
    proxyName: string | null;
    cookies: unknown[];
    format: "json" | "netscape";
    password?: string | undefined;
  }): Promise<{ sent: true; encrypted: boolean; cookies: number }> {
    if (!this.deps.settings().discordCookieExport) {
      throw new DomainError(ErrorCodes.FORBIDDEN, "cookie export to Discord is off (Settings → Sites → Discord cookie export)");
    }
    const body = args.format === "netscape" ? toNetscape(args.cookies) : JSON.stringify(args.cookies, null, 2);
    const safe = args.profileName.replace(/[^\w.-]+/g, "_").slice(0, 60) || "profile";
    let file: { name: string; body: Buffer };
    if (args.password !== undefined) {
      if (args.password.length < 8) throw new DomainError(ErrorCodes.VALIDATION_FAILED, "the export password must be at least 8 characters");
      file = { name: `${safe}-cookies.qpenc.json`, body: Buffer.from(JSON.stringify(encryptExport(body, args.password)), "utf8") };
    } else {
      file = { name: `${safe}-cookies.${args.format === "netscape" ? "txt" : "json"}`, body: Buffer.from(body, "utf8") };
    }
    await this.sendNow({
      content: clip(
        `**🍪 Cookie export** · ${args.profileName} · exit IP ${args.exitIp ?? "unknown"} · proxy ${args.proxyName ?? "none"} · ${args.cookies.length} cookies${args.password !== undefined ? " · encrypted" : ""}`,
      ),
      file,
    });
    return { sent: true, encrypted: args.password !== undefined, cookies: args.cookies.length };
  }

  private enqueue(m: Outgoing): void {
    if (this.queue.length >= 50) return; // a flood is dropped, never a backlog that posts for hours
    this.queue.push(m);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    try {
      while (this.queue.length) {
        const m = this.queue.shift()!;
        await this.sendNow(m).catch(() => {});
      }
    } finally {
      this.sending = false;
    }
  }

  private async sendNow(m: Outgoing): Promise<void> {
    const url = this.deps.secrets.get(DISCORD_WEBHOOK_KEY);
    if (!url || !isDiscordWebhook(url)) throw new DomainError(ErrorCodes.VALIDATION_FAILED, "no Discord webhook configured");
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    const now = this.deps.now ?? Date.now;
    const gap = 2100 - (now() - this.lastSentAt);
    if (gap > 0) await sleep(gap);
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await (this.deps.fetch ?? fetch)(url, { method: "POST", ...requestBody(m), redirect: "error", signal: AbortSignal.timeout(15_000) });
      this.lastSentAt = now();
      if (res.status === 429 && attempt === 0) {
        const j = (await res.json().catch(() => ({}))) as { retry_after?: number };
        await sleep(Math.min(60, Math.max(1, Number(j.retry_after) || 2)) * 1000);
        continue;
      }
      if (!res.ok) throw new DomainError(ErrorCodes.VALIDATION_FAILED, `Discord refused the message (HTTP ${res.status})`);
      return;
    }
    throw new DomainError(ErrorCodes.VALIDATION_FAILED, "Discord rate limit: try again shortly");
  }
}

function requestBody(m: Outgoing): { body: string | FormData; headers?: Record<string, string> } {
  const payload = { content: m.content, allowed_mentions: { parse: [] as string[] } };
  if (!m.file) return { body: JSON.stringify(payload), headers: { "content-type": "application/json" } };
  const fd = new FormData();
  fd.append("payload_json", JSON.stringify(payload));
  fd.append("files[0]", new Blob([m.file.body], { type: "application/octet-stream" }), m.file.name);
  return { body: fd };
}

const clip = (s: string): string => (s.length > 1900 ? `${s.slice(0, 1899)}…` : s);

function toNetscape(cookies: unknown[]): string {
  const lines = ["# Netscape HTTP Cookie File"];
  for (const c of cookies as { domain?: string; path?: string; secure?: boolean; expires?: number; name?: string; value?: string }[]) {
    const domain = c.domain ?? "";
    lines.push([domain, domain.startsWith(".") ? "TRUE" : "FALSE", c.path ?? "/", c.secure ? "TRUE" : "FALSE", Math.max(0, Math.floor(c.expires ?? 0)), c.name ?? "", c.value ?? ""].join("\t"));
  }
  return `${lines.join("\n")}\n`;
}

/** The encrypted export file (version 1). */
export interface EncryptedExport {
  format: "queuepilot-cookie-export";
  v: 1;
  kdf: "scrypt";
  cipher: "aes-256-gcm";
  salt: string;
  iv: string;
  tag: string;
  data: string;
  note: string;
}

export function encryptExport(plain: string, password: string): EncryptedExport {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(password, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const c = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return {
    format: "queuepilot-cookie-export",
    v: 1,
    kdf: "scrypt",
    cipher: "aes-256-gcm",
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: c.getAuthTag().toString("base64"),
    data: data.toString("base64"),
    note: "Decrypt in QueuePilot: Cookies → Import encrypted export, with the password you chose.",
  };
}

export function decryptExport(file: unknown, password: string): string {
  const f = file as Partial<EncryptedExport>;
  if (f?.format !== "queuepilot-cookie-export" || f.v !== 1 || !f.salt || !f.iv || !f.tag || !f.data) {
    throw new DomainError(ErrorCodes.VALIDATION_FAILED, "not a QueuePilot encrypted cookie export");
  }
  try {
    const key = scryptSync(password, Buffer.from(f.salt, "base64"), 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    const d = createDecipheriv("aes-256-gcm", key, Buffer.from(f.iv, "base64"));
    d.setAuthTag(Buffer.from(f.tag, "base64"));
    return Buffer.concat([d.update(Buffer.from(f.data, "base64")), d.final()]).toString("utf8");
  } catch {
    throw new DomainError(ErrorCodes.VALIDATION_FAILED, "wrong password or damaged file");
  }
}
