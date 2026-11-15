import { z } from "zod";

/**
 * Jancy URL column → launch behavior. The CSV `url` column (and the persona
 * patch `startUrls` field) store pages to open automatically right after the
 * profile launches. Read through this helper, never raw: a malformed bag
 * value degrades to "no start pages", never to a launch-time crash.
 */

const StartUrlsSchema = z.array(z.string().url().max(4000)).max(25);

/** Validated start pages from a profile's extra bag ([] when absent/bad). */
export function startUrlsOf(extra: Record<string, unknown> | null): string[] {
  if (!extra || !("startUrls" in extra)) return [];
  const parsed = StartUrlsSchema.safeParse(extra.startUrls);
  return parsed.success ? parsed.data : [];
}
