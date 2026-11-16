import { RotationLinkSchema, type Profile, type RotationLink } from "@queuepilot/contracts";

/**
 * Proxy rotation link (D-003) — typed read of `profile.extra.rotationLink`.
 * Safe-parse by design like every other persona-bag reader: a malformed bag
 * degrades to "no link", never to a launch-time crash.
 */
export function rotationLinkOf(
  extra: Record<string, unknown> | null,
): RotationLink | null {
  const raw = (extra ?? {}).rotationLink;
  const parsed = RotationLinkSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Write the link into a profile's extra bag (used by ProfileService). */
export function withRotationLink(p: Profile, link: RotationLink | null): Profile {
  const extra = { ...(p.extra ?? {}) };
  if (link) extra.rotationLink = link;
  else delete extra.rotationLink;
  return { ...p, extra, updatedAt: new Date().toISOString() };
}
