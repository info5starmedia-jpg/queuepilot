import { randomUUID } from "node:crypto";
import { DomainError, ErrorCodes } from "@queuepilot/contracts";
import { z } from "zod";
import type { Db } from "../../infrastructure/database.js";
import type { SecretStore } from "../secrets/secret-store.js";
import { imapLoginCheck, type ImapAccountLookup, type ImapConnect } from "../resolvers/imap-resolver.js";

/**
 * Email accounts for the IMAP resolver (Gmail app passwords and any other
 * IMAP mailbox). Several accounts side by side; the console adds and removes
 * them in Settings → Integrations.
 *
 * Discipline (same as proxy passwords and card PANs):
 * - The app password lives ONLY in the SecretStore (DPAPI on Windows) under
 *   `email.<id>.password`; the row holds email/server/port.
 * - Write-only: no read route ever returns it; `hasPassword` says it exists.
 * - Resolver use: `imap:you@gmail.com[?query=…]` looks the account up here.
 */

export const CreateEmailAccountInputSchema = z.object({
  email: z.string().trim().email().max(254),
  /** Gmail app password (16 letters; spaces as Google shows them are fine). */
  appPassword: z.string().min(1).max(200),
  host: z
    .string()
    .trim()
    .min(1)
    .max(253)
    .regex(/^[a-zA-Z0-9.-]+$/, "invalid server name")
    .default("imap.gmail.com"),
  port: z.number().int().min(1).max(65535).default(993),
  /** false = plain IMAP (testing only); default TLS. */
  tls: z.boolean().default(true),
});
export type CreateEmailAccountInput = z.input<typeof CreateEmailAccountInputSchema>;

export interface EmailAccount {
  id: string;
  email: string;
  host: string;
  port: number;
  tls: boolean;
  hasPassword: boolean;
  createdAt: string;
}

interface Row {
  id: string;
  email: string;
  host: string;
  port: number;
  tls: number;
  created_at: string;
}

const secretKey = (id: string) => `email.${id}.password`;

export class EmailAccountService implements ImapAccountLookup {
  constructor(
    private readonly db: Db,
    private readonly secrets: SecretStore,
    /** Injectable for tests; defaults to a real TCP/TLS connect. */
    private readonly connect?: ImapConnect,
  ) {}

  list(): EmailAccount[] {
    return (this.db.prepare("SELECT * FROM email_accounts ORDER BY email").all() as Row[]).map((r) =>
      this.toAccount(r),
    );
  }

  create(input: CreateEmailAccountInput): EmailAccount {
    const v = CreateEmailAccountInputSchema.parse(input);
    const email = v.email.toLowerCase();
    if (this.db.prepare("SELECT 1 FROM email_accounts WHERE email = ?").get(email)) {
      throw new DomainError(ErrorCodes.CONFLICT, `${email} is already added — remove it first to change it`);
    }
    const id = randomUUID();
    // Google shows app passwords in four groups of four; IMAP wants them joined.
    const password = v.host.endsWith("gmail.com") ? v.appPassword.replace(/\s+/g, "") : v.appPassword;
    this.secrets.set(secretKey(id), password);
    this.db
      .prepare("INSERT INTO email_accounts (id, email, host, port, tls, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, email, v.host.toLowerCase(), v.port, v.tls ? 1 : 0, new Date().toISOString());
    return this.get(id);
  }

  get(id: string): EmailAccount {
    const r = this.db.prepare("SELECT * FROM email_accounts WHERE id = ?").get(id) as Row | undefined;
    if (!r) throw new DomainError(ErrorCodes.EMAIL_ACCOUNT_NOT_FOUND, `email account ${id} not found`);
    return this.toAccount(r);
  }

  delete(id: string): void {
    this.get(id);
    this.secrets.delete(secretKey(id));
    this.db.prepare("DELETE FROM email_accounts WHERE id = ?").run(id);
  }

  /** Log in and open INBOX; reports the server's answer, never the password. */
  async test(id: string): Promise<{ ok: boolean; error: string | null }> {
    const account = this.get(id);
    const pass = this.secrets.get(secretKey(id));
    if (!pass) return { ok: false, error: "no app password stored — remove and re-add this account" };
    return imapLoginCheck(
      { host: account.host, port: account.port, tls: account.tls, user: account.email, pass },
      this.connect,
    );
  }

  /** ImapAccountLookup: credentials for the resolver, by email. */
  forEmail(email: string): { host: string; port: number; tls: boolean; user: string; pass: string } | null {
    const r = this.db
      .prepare("SELECT * FROM email_accounts WHERE email = ?")
      .get(email.trim().toLowerCase()) as Row | undefined;
    if (!r) return null;
    const pass = this.secrets.get(secretKey(r.id));
    if (!pass) return null;
    return { host: r.host, port: r.port, tls: r.tls === 1, user: r.email, pass };
  }

  private toAccount(r: Row): EmailAccount {
    return {
      id: r.id,
      email: r.email,
      host: r.host,
      port: r.port,
      tls: r.tls === 1,
      hasPassword: this.secrets.get(secretKey(r.id)) !== null,
      createdAt: r.created_at,
    };
  }
}
