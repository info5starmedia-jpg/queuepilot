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
});
export type CreateProxyInput = z.input<typeof CreateProxyInputSchema>;

export const UpdateProxyInputSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    type: ProxyTypeSchema.optional(),
    host: HostSchema.optional(),
    port: z.number().int().min(1).max(65535).optional(),
    username: z.string().max(200).nullable().optional(),
    password: z.string().max(200).nullable().optional(),
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
