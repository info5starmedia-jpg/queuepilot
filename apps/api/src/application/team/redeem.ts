import { DomainError, ErrorCodes } from "@queuepilot/contracts";

/**
 * LIC follow-up: a tester pastes the one-time invite (`qpi_…`) the owner
 * sent and the team server URL; this redeems it for their licence key.
 * The key goes straight into Settings → Team and is never returned.
 *
 * The server URL must be https (plain http only for a loopback server, which
 * is how the team server is developed); redirects are refused so an invite
 * can't be bounced to another host.
 */
export async function redeemInvite(
  serverUrl: string,
  invite: string,
  name: string | undefined,
  f: typeof fetch = fetch,
): Promise<{ serverUrl: string; token: string }> {
  let u: URL;
  try {
    u = new URL(serverUrl);
  } catch {
    throw new DomainError(ErrorCodes.VALIDATION_FAILED, "that is not a server URL");
  }
  const loopback = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) {
    throw new DomainError(ErrorCodes.VALIDATION_FAILED, "the team server URL must be https");
  }
  if (u.username || u.password) throw new DomainError(ErrorCodes.VALIDATION_FAILED, "the server URL must not contain credentials");
  if (!/^qpi_[\w-]{20,64}$/.test(invite)) throw new DomainError(ErrorCodes.VALIDATION_FAILED, "that does not look like an invite (qpi_…)");

  const base = u.origin;
  let res: Response;
  try {
    res = await f(`${base}/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ invite, ...(name ? { name } : {}) }),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new DomainError(ErrorCodes.VALIDATION_FAILED, "could not reach the team server");
  }
  if (res.status === 401) throw new DomainError(ErrorCodes.VALIDATION_FAILED, "the invite is unknown, already used, or expired — ask the owner for a new one");
  if (!res.ok) throw new DomainError(ErrorCodes.VALIDATION_FAILED, `the team server refused the invite (HTTP ${res.status})`);
  const j = (await res.json().catch(() => ({}))) as { token?: unknown };
  if (typeof j.token !== "string" || j.token.length < 10) throw new DomainError(ErrorCodes.VALIDATION_FAILED, "the team server sent no key");
  return { serverUrl: base, token: j.token };
}
