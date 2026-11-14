import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getOrCreateOscryptKey,
  oscryptKeyPath,
} from "../src/application/runtime/oscrypt-key.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "qp-oscrypt-test-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("oscrypt key management", () => {
  it("creates a 32-byte key on first use and reuses it after", () => {
    const p1 = getOrCreateOscryptKey(dir);
    const key1 = fs.readFileSync(p1);
    expect(key1.length).toBe(32);
    expect(p1).toBe(oscryptKeyPath(dir));
    const p2 = getOrCreateOscryptKey(dir);
    expect(p2).toBe(p1);
    expect(fs.readFileSync(p2)).toEqual(key1);
  });

  it("keys differ between profiles", () => {
    const a = fs.readFileSync(getOrCreateOscryptKey(path.join(dir, "a")));
    const b = fs.readFileSync(getOrCreateOscryptKey(path.join(dir, "b")));
    expect(a.equals(b)).toBe(false);
  });

  it("a wrong-sized key file is set aside, not overwritten, and a new key is minted", () => {
    const keyPath = oscryptKeyPath(dir);
    fs.mkdirSync(path.dirname(keyPath), { recursive: true });
    fs.writeFileSync(keyPath, Buffer.from("short"));
    const p = getOrCreateOscryptKey(dir);
    const key = fs.readFileSync(p);
    expect(key.length).toBe(32);
    expect(key.toString()).not.toBe("short");
    // the bad file survives aside
    const asides = fs.readdirSync(path.dirname(keyPath)).filter((f) => f.includes(".bad-"));
    expect(asides).toHaveLength(1);
  });
});
