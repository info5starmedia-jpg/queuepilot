import { z } from "zod";

/**
 * Proxy contract. Passwords are write-only over the API: list/get responses
 * never include them, and at rest they live in the `proxies` table behind the
 * data directory's filesystem permissions. A future milestone moves them to
 * the OS keychain (see docs/roadmap.md).
 */
export const ProxyTypeSchema = z.enum(["http", "https", "socks5"]);
export type ProxyType = z.infer<typeof ProxyTypeSchema>;

const HostSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[a-zA-Z0-9._-]+$/, "invalid host");

export const ProxySchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(120),
  type: ProxyTypeSchema,
  host: HostSchema,
  port: z.number().int().min(1).max(65535),
  username: z.string().max(200).nullable(),
  /** Optional timezone carried by the proxy (provider files' 6th column). */
  timezone: z.string().nullable().default(null),
  /** Importing provider, if any. */
  providerId: z.string().uuid().nullable().default(null),
  /** Folder the proxy is filed under (same model as profile groups). */
  group: z.string().max(120).default("default"),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Proxy = z.infer<typeof ProxySchema>;

export const CreateProxyInputSchema = z.object({
  name: z.string().min(1).max(120),
  type: ProxyTypeSchema,
  host: HostSchema,
  port: z.number().int().min(1).max(65535),
  username: z.string().max(200).nullable().optional(),
  password: z.string().max(200).nullable().optional(),
  /** IANA zone the browser should use behind this proxy (beats the exit-IP lookup). */
  timezone: z.string().max(64).nullable().optional(),
  group: z.string().trim().min(1).max(120).optional(),
});
export type CreateProxyInput = z.input<typeof CreateProxyInputSchema>;

/**
 * Bulk import: a pasted list or a .txt file's contents, one proxy per line
 * (host:port, host:port:user:pass, optional trailing timezone, scheme://
 * prefix, blank lines and # comments tolerated). `type` is the default for
 * lines without a scheme.
 */
export const ImportProxiesInputSchema = z.object({
  text: z.string().max(1_000_000),
  type: ProxyTypeSchema.default("http"),
  /** Group every imported proxy lands in (default "default"). */
  group: z.string().trim().min(1).max(120).optional(),
});
export type ImportProxiesInput = z.input<typeof ImportProxiesInputSchema>;

export const UpdateProxyInputSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    type: ProxyTypeSchema.optional(),
    host: HostSchema.optional(),
    port: z.number().int().min(1).max(65535).optional(),
    username: z.string().max(200).nullable().optional(),
    password: z.string().max(200).nullable().optional(),
    group: z.string().trim().min(1).max(120).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "at least one field is required",
  });
export type UpdateProxyInput = z.input<typeof UpdateProxyInputSchema>;

/**
 * Temporary proxy: a one-shot proxy passed at launch time that applies to a
 * single browser run and dies with it. It is never written to the proxies
 * table and never mutates the profile's attached proxy — the profile's own
 * proxy applies again at the next start. Credentials stay in-process and in
 * the launch snapshot (the run's identity of record), nowhere else.
 */
export const TempProxyInputSchema = z.object({
  type: ProxyTypeSchema,
  host: HostSchema,
  port: z.number().int().min(1).max(65535),
  username: z.string().max(200).nullable().optional(),
  password: z.string().max(200).nullable().optional(),
});
export type TempProxyInput = z.input<typeof TempProxyInputSchema>;

/** Build the URL an engine's --proxy-server flag expects. Never logged. */
export function proxyUrl(p: {
  type: ProxyType;
  host: string;
  port: number;
  username: string | null;
  password?: string | null;
}): string {
  const auth = p.username
    ? `${encodeURIComponent(p.username)}${p.password ? `:${encodeURIComponent(p.password)}` : ""}@`
    : "";
  return `${p.type}://${auth}${p.host}:${p.port}`;
}
