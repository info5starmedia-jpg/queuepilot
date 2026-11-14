import { describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { BrowserRunRepository } from "../src/application/lifecycle/browser-run.repository.js";
import { openTestDatabase } from "../src/infrastructure/database.js";
import {
  captureProcessStartToken,
  isProcessAlive,
} from "../src/infrastructure/process-inventory.js";

/**
 * D-002: anti-PID-reuse start tokens. These tests use REAL child processes:
 * a sleeper we spawn ourselves plays the engine, and a wrong token against
 * its live PID simulates the exact reuse attack (same PID, different process
 * generation).
 */

function spawnSleeper(): ChildProcess {
  return spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
    stdio: "ignore",
  });
}

describe("captureProcessStartToken", () => {
  it("captures a stable token for a live process", () => {
    const child = spawnSleeper();
    try {
      const t1 = captureProcessStartToken(child.pid!);
      const t2 = captureProcessStartToken(child.pid!);
      expect(t1).toBeTruthy();
      expect(t1).toBe(t2); // same process generation, same token
      expect(t1).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    } finally {
      child.kill();
    }
  });

  it("returns null for dead/garbage pids, never throws", () => {
    expect(captureProcessStartToken(-5)).toBeNull();
    expect(captureProcessStartToken(0)).toBeNull();
    // 999999 is almost certainly not a live pid; if it somehow is, the token
    // is still well-formed — assert shape only.
    const t = captureProcessStartToken(999999);
    if (t !== null) expect(t).toMatch(/^\d{4}-/);
  });
});

describe("isProcessAlive with start tokens (D-002)", () => {
  it("same PID + matching token = alive", () => {
    const child = spawnSleeper();
    try {
      const token = captureProcessStartToken(child.pid!);
      expect(isProcessAlive(child.pid!, token)).toBe(true);
    } finally {
      child.kill();
    }
  });

  it("same PID + WRONG token = treated as dead (the PID-reuse attack)", () => {
    const child = spawnSleeper();
    try {
      expect(isProcessAlive(child.pid!, "2020-01-01T00:00:00Z")).toBe(false);
      expect(isProcessAlive(child.pid!, "definitely-not-our-process")).toBe(false);
    } finally {
      child.kill();
    }
  });

  it("null/undefined token keeps plain liveness (pre-D-002 rows, capture failures)", () => {
    const child = spawnSleeper();
    try {
      expect(isProcessAlive(child.pid!)).toBe(true);
      expect(isProcessAlive(child.pid!, null)).toBe(true);
    } finally {
      child.kill();
    }
    // After death, even a token cannot resurrect it.
    expect(isProcessAlive(child.pid!, "anything")).toBe(false);
  });

  it("rejects invalid pids outright", () => {
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
    expect(isProcessAlive(1.5)).toBe(false);
  });
});

describe("run rows persist the token", () => {
  it("create/get round-trips processToken through migration 004", () => {
    const db = openTestDatabase();
    // browser_runs has a FK into profiles — the parent row must exist.
    db.prepare(
      `INSERT INTO profiles (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`,
    ).run(
      "22222222-2222-4222-8222-222222222222",
      "tok",
      new Date().toISOString(),
      new Date().toISOString(),
    );
    const runs = new BrowserRunRepository(db);
    runs.create({
      id: "11111111-1111-4111-8111-111111111111",
      profileId: "22222222-2222-4222-8222-222222222222",
      status: "running",
      pid: 4242,
      processToken: "2026-11-14T12:00:00Z",
      debugPort: 9222,
      wsEndpoint: null,
      startedAt: new Date().toISOString(),
      stoppedAt: null,
      lastError: null,
    });
    expect(runs.get("11111111-1111-4111-8111-111111111111")?.processToken).toBe(
      "2026-11-14T12:00:00Z",
    );
    // Rows written before D-002 (token NULL) still read back as null.
    runs.update({
      ...runs.get("11111111-1111-4111-8111-111111111111")!,
      processToken: null,
    });
    expect(runs.get("11111111-1111-4111-8111-111111111111")?.processToken).toBeNull();
  });
});
