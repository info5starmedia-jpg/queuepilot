import { z } from "zod";

/**
 * Tab & session-partition contract (the Jancy session model).
 *
 * A browser run owns tabs; every tab lives in exactly one session partition.
 * Partitions are the isolation boundary: tabs in the same partition share an
 * in-memory session (cookies, storage), tabs in different partitions are
 * isolated from each other. A tab opened with `relatedTo` joins the parent
 * tab's partition; a tab opened without it gets a fresh partition of its own.
 *
 * Nothing here is durable BY DESIGN: partitions are in-memory session state,
 * so tabs and partitions die with the run and are never written to disk. The
 * durable record remains the run row and its launch snapshot.
 */
export const SessionPartitionSchema = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  createdAt: z.string().datetime(),
});
export type SessionPartition = z.infer<typeof SessionPartitionSchema>;

export const BrowserTabStatusSchema = z.enum(["open", "closed"]);
export type BrowserTabStatus = z.infer<typeof BrowserTabStatusSchema>;

export const BrowserTabSchema = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  profileId: z.string().uuid(),
  partitionId: z.string().uuid(),
  /** Engine-side handle (e.g. CDP target id) when the runtime provides one. */
  engineTabId: z.string().nullable(),
  url: z.string().nullable(),
  /** Set when this tab was opened as related to another tab. */
  relatedToTabId: z.string().uuid().nullable(),
  status: BrowserTabStatusSchema,
  createdAt: z.string().datetime(),
  closedAt: z.string().datetime().nullable(),
});
export type BrowserTab = z.infer<typeof BrowserTabSchema>;

/**
 * Open-tab input. `relatedTo` is the whole partitioning story: pass the id of
 * an open tab in the same run and the new tab shares its session partition
 * (spawned/ctrl-clicked tabs in Jancy terms); omit it and the tab is isolated.
 */
export const OpenTabInputSchema = z
  .object({
    url: z.string().url().max(4000).nullish(),
    relatedTo: z.string().uuid().nullish(),
  })
  .strict();
export type OpenTabInput = z.input<typeof OpenTabInputSchema>;
