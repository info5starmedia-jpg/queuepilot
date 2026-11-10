import { describe, expect, it, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { DomainError, ErrorCodes } from "@queuepilot/contracts";
import { CdpTabController } from "../src/application/runtime/cdp/cdp-tab-controller.js";
import { CamoufoxSession } from "../src/application/runtime/camoufox.runtime.js";
import { MockCdpServer } from "./helpers/mock-cdp-server.js";

let server: MockCdpServer | null = null;

afterEach(async () => {
  await server?.stop();
  server = null;
});

async function startServer(): Promise<{
  server: MockCdpServer;
  port: number;
  wsUrl: string;
}> {
  server = new MockCdpServer();
  const { port, wsUrl } = await server.start();
  return { server, port, wsUrl };
}

/** A fake engine process: kill() emits exit synchronously, like a real one. */
function mockChild(): ChildProcess {
  const emitter = new EventEmitter();
  const child = emitter as unknown as ChildProcess & {
    exitCode: number | null;
    killed: boolean;
    pid: number;
    kill: (signal?: number | NodeJS.Signals) => boolean;
  };
  child.pid = 43_210;
  child.exitCode = null;
  child.killed = false;
  child.kill = (signal?: number | NodeJS.Signals) => {
    child.killed = true;
    child.exitCode = 0;
    emitter.emit("exit", 0, signal ?? null);
    return true;
  };
  return child;
}

describe("CdpTabController", () => {
  it("creates a browser context per partition and a target inside it", async () => {
    const { server: srv, wsUrl } = await startServer();
    const tabs = new CdpTabController(wsUrl);

    const opened = await tabs.openTab("https://a.example", "partition-1");
    expect(opened.engineTabId).toBe("target-1");

    const ctxCalls = srv.callsFor("Target.createBrowserContext");
    const targetCalls = srv.callsFor("Target.createTarget");
    expect(ctxCalls).toHaveLength(1);
    expect(targetCalls).toHaveLength(1);
    expect(targetCalls[0]!.params).toMatchObject({
      url: "https://a.example",
      browserContextId: "ctx-1",
      newWindow: false,
    });

    await tabs.dispose();
  });

  it("reuses the context for the same partition; a new partition gets a new context", async () => {
    const { server: srv, wsUrl } = await startServer();
    const tabs = new CdpTabController(wsUrl);

    await tabs.openTab(null, "partition-1");
    await tabs.openTab(null, "partition-1"); // related: same partition
    await tabs.openTab(null, "partition-2"); // isolated: new partition

    expect(srv.callsFor("Target.createBrowserContext")).toHaveLength(2);
    const contexts = srv
      .callsFor("Target.createTarget")
      .map((c) => c.params.browserContextId);
    expect(contexts).toEqual(["ctx-1", "ctx-1", "ctx-2"]);

    await tabs.dispose();
  });

  it("closeTab issues Target.closeTarget, and dispose releases every context", async () => {
    const { server: srv, wsUrl } = await startServer();
    const tabs = new CdpTabController(wsUrl);

    await tabs.openTab(null, "p1");
    const second = await tabs.openTab(null, "p2");
    await tabs.closeTab(second.engineTabId);

    expect(srv.callsFor("Target.closeTarget")[0]!.params).toEqual({
      targetId: second.engineTabId,
    });

    await tabs.dispose();
    expect(srv.callsFor("Target.disposeBrowserContext")).toHaveLength(2);
  });

  it("an engine without browser contexts gets TABS_UNSUPPORTED, never a fake isolated tab", async () => {
    const { server: srv, wsUrl } = await startServer();
    srv.supportsContexts = false;
    const tabs = new CdpTabController(wsUrl);

    await expect(tabs.openTab(null, "p1")).rejects.toSatisfy(
      (e) => e instanceof DomainError && e.code === ErrorCodes.TABS_UNSUPPORTED,
    );
    // And critically: no tab was opened anywhere.
    expect(srv.callsFor("Target.createTarget")).toHaveLength(0);

    await tabs.dispose();
  });
});

describe("CamoufoxSession tab routing", () => {
  it("discovers the debugger URL via /json/version and routes tabs by partition", async () => {
    const { port } = await startServer();
    const session = new CamoufoxSession(mockChild(), port);

    const parent = await session.openTab({
      url: "https://shop.example",
      partitionKey: "p1",
    });
    const child = await session.openTab({ url: null, partitionKey: "p1" });
    const other = await session.openTab({ url: null, partitionKey: "p2" });

    expect(parent.engineTabId).toBeTruthy();
    expect(child.engineTabId).not.toBe(parent.engineTabId);
    expect(other.engineTabId).not.toBe(child.engineTabId);

    const ctxByTarget = server!
      .callsFor("Target.createTarget")
      .map((c) => c.params.browserContextId);
    expect(ctxByTarget).toEqual(["ctx-1", "ctx-1", "ctx-2"]);

    await session.closeTab(child.engineTabId);
    expect(server!.callsFor("Target.closeTarget")).toHaveLength(1);

    await session.stop(); // disposes contexts, then SIGTERMs the engine
    expect(server!.callsFor("Target.disposeBrowserContext")).toHaveLength(2);
    const { code } = await session.exited;
    expect(code).toBe(0);
  });
});
