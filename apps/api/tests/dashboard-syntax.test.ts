import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import vm from "node:vm";
/**
 * v0.14.20 regression guard: the dashboard ships as a single ES module —
 * one syntax error (e.g. `await` inside a non-async function, introduced in
 * v0.14.16's renderProfileGrid and dead-silent until someone opened the
 * console) kills EVERY handler on the page. Parse every dashboard .js file
 * as an ES module at test time; anything unparsable fails the suite.
 */

const DASHBOARD_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "dashboard");

describe("dashboard JS parses as an ES module", () => {
  const files = readdirSync(DASHBOARD_DIR).filter((f) => f.endsWith(".js"));

  it("found the dashboard scripts", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(`${file} parses`, () => {
      const src = readFileSync(join(DASHBOARD_DIR, file), "utf8");
      // Script-goal parse: catches the exact bug this guards (await inside a
      // non-async function). The dashboard files use no import/export, so
      // script goal covers everything they contain — and needs no flags.
      expect(() => new vm.Script(src, { filename: file })).not.toThrow();
    });
  }
});
