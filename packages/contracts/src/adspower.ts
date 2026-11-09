import { z } from "zod";

/**
 * AdsPower-compatible Local API surface.
 *
 * Third-party automation tooling (Dolphin-style scripts, ad farms, ticket
 * tooling) targets the AdsPower local API by convention. Matching its
 * envelope — { code, msg, data } with code 0 = success — makes QueuePilot a
 * drop-in backend for that tooling without our own SDK.
 */
export const AdsPowerEnvelopeSchema = z.object({
  code: z.number().int(),
  msg: z.string(),
  data: z.unknown().optional(),
});
export type AdsPowerEnvelope = z.infer<typeof AdsPowerEnvelopeSchema>;

export const ADSPOWER_OK = 0;
export const ADSPOWER_ERR = 1;

export function adsOk(data: unknown): AdsPowerEnvelope {
  return { code: ADSPOWER_OK, msg: "success", data };
}

export function adsErr(message: string): AdsPowerEnvelope {
  return { code: ADSPOWER_ERR, msg: message };
}

/** Shape AdsPower returns from /api/v1/browser/start. */
export const AdsPowerStartDataSchema = z.object({
  ws: z.object({
    puppeteer: z.string(),
    selenium: z.string(),
  }),
  debug_port: z.string(),
  webdriver: z.string().optional(),
});
export type AdsPowerStartData = z.infer<typeof AdsPowerStartDataSchema>;
