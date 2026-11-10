import { randomUUID } from "node:crypto";
import {
  DomainError,
  ErrorCodes,
  type BrowserTab,
  type SessionPartition,
} from "@queuepilot/contracts";

/**
 * TabRegistry — in-memory tab/partition state for live runs.
 *
 * The one rule that defines the model: a tab opened with `relatedTo` joins
 * that tab's session partition; any other tab gets a fresh partition. Tabs in
 * a partition share an in-memory session; partitions are isolated from each
 * other. Nothing here is persisted — partitions are session state, so they
 * die with the run (clearRun on stop/crash) and an API restart starts empty
 * (adopted runs honestly report "tab state unknown" upstream).
 */
export class TabRegistry {
  private readonly tabs = new Map<string, BrowserTab>();
  private readonly partitions = new Map<string, SessionPartition>();
  private readonly partitionIdsByRun = new Map<string, Set<string>>();

  /**
   * Resolve which partition a new tab belongs to. `relatedTo` must reference
   * an OPEN tab in the SAME run — relating across runs would leak sessions
   * across profile boundaries, which is exactly what the model exists to
   * prevent. Without `relatedTo`, a fresh partition is created.
   */
  resolvePartition(
    runId: string,
    relatedTo: string | null,
  ): { partition: SessionPartition; relatedToTabId: string | null } {
    if (relatedTo) {
      const parent = this.tabs.get(relatedTo);
      if (!parent || parent.runId !== runId || parent.status !== "open") {
        throw new DomainError(
          ErrorCodes.TAB_NOT_FOUND,
          `related tab ${relatedTo} is not an open tab of run ${runId}`,
        );
      }
      const partition = this.partitions.get(parent.partitionId);
      if (!partition)
        throw new Error(
          `partition ${parent.partitionId} missing — registry corrupt`,
        );
      return { partition, relatedToTabId: parent.id };
    }
    const partition: SessionPartition = {
      id: randomUUID(),
      runId,
      createdAt: new Date().toISOString(),
    };
    this.partitions.set(partition.id, partition);
    this.track(runId, partition.id);
    return { partition, relatedToTabId: null };
  }

  recordTab(args: {
    runId: string;
    profileId: string;
    partitionId: string;
    engineTabId: string | null;
    url: string | null;
    relatedToTabId: string | null;
  }): BrowserTab {
    const tab: BrowserTab = {
      id: randomUUID(),
      runId: args.runId,
      profileId: args.profileId,
      partitionId: args.partitionId,
      engineTabId: args.engineTabId,
      url: args.url,
      relatedToTabId: args.relatedToTabId,
      status: "open",
      createdAt: new Date().toISOString(),
      closedAt: null,
    };
    this.tabs.set(tab.id, tab);
    return tab;
  }

  /** Undo a just-created partition when the engine failed to open the tab. */
  dropPartitionIfEmpty(partitionId: string): void {
    const hasTabs = [...this.tabs.values()].some(
      (t) => t.partitionId === partitionId,
    );
    if (hasTabs) return;
    const partition = this.partitions.get(partitionId);
    if (!partition) return;
    this.partitions.delete(partitionId);
    this.partitionIdsByRun.get(partition.runId)?.delete(partitionId);
  }

  getForRun(runId: string, tabId: string): BrowserTab {
    const tab = this.tabs.get(tabId);
    if (!tab || tab.runId !== runId) {
      throw new DomainError(
        ErrorCodes.TAB_NOT_FOUND,
        `tab ${tabId} not found in run ${runId}`,
      );
    }
    return tab;
  }

  markClosed(tabId: string): BrowserTab {
    const tab = this.tabs.get(tabId);
    if (!tab)
      throw new DomainError(ErrorCodes.TAB_NOT_FOUND, `tab ${tabId} not found`);
    if (tab.status === "closed") return tab; // idempotent close
    const closed: BrowserTab = {
      ...tab,
      status: "closed",
      closedAt: new Date().toISOString(),
    };
    this.tabs.set(tabId, closed);
    return closed;
  }

  listForRun(runId: string): {
    tabs: BrowserTab[];
    partitions: SessionPartition[];
  } {
    const tabs = [...this.tabs.values()].filter((t) => t.runId === runId);
    const partitions = [...(this.partitionIdsByRun.get(runId) ?? [])]
      .map((id) => this.partitions.get(id))
      .filter((p): p is SessionPartition => p !== undefined);
    return { tabs, partitions };
  }

  /** Runs own their tabs; when the run ends, all of its tab state goes. */
  clearRun(runId: string): void {
    for (const [id, tab] of this.tabs) {
      if (tab.runId === runId) this.tabs.delete(id);
    }
    for (const partitionId of this.partitionIdsByRun.get(runId) ?? []) {
      this.partitions.delete(partitionId);
    }
    this.partitionIdsByRun.delete(runId);
  }

  private track(runId: string, partitionId: string): void {
    let set = this.partitionIdsByRun.get(runId);
    if (!set) {
      set = new Set();
      this.partitionIdsByRun.set(runId, set);
    }
    set.add(partitionId);
  }
}
