import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Static wiring guard for the ops console. setView() dereferences
 * `#view-<name>` for EVERY entry in VIEWS, so a view listed in app.js without
 * its <section> in index.html throws on the first click and view switching
 * dies for the whole console — silently, like the v0.14.20 syntax bug. The
 * dashboard is zero-build vanilla JS, so this is checked from source text.
 */

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "dashboard");
const appJs = readFileSync(join(DIR, "app.js"), "utf8");
const html = readFileSync(join(DIR, "index.html"), "utf8");

const views = JSON.parse(/const VIEWS = (\[[^\]]+\]);/.exec(appJs)![1]!) as string[];
const shortcuts = Object.fromEntries(
  [...(/const map = \{([^}]+)\};/.exec(appJs)![1] ?? "").matchAll(/(\w): "(\w+)"/g)].map((m) => [
    m[2]!,
    m[1]!,
  ]),
);
const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]!));

describe("dashboard views are wired end to end", () => {
  it("nav order: Tab View + Deck after Tabs; Cookie Thinger + Autofill Map after Cookies; Warmups before Providers", () => {
    expect(views).toEqual([
      "profiles",
      "proxies",
      "tabs",
      "tabview",
      "deck",
      "cookies",
      "thinger",
      "autofill",
      "warmups",
      "providers",
      "events",
      "settings",
    ]);
    expect({
      tabview: shortcuts.tabview,
      deck: shortcuts.deck,
      thinger: shortcuts.thinger,
      autofill: shortcuts.autofill,
      warmups: shortcuts.warmups,
    }).toEqual({ tabview: "n", deck: "d", thinger: "k", autofill: "a", warmups: "w" });
  });

  it("the sidebar lists the views in the same order as VIEWS", () => {
    const navOrder = [...html.matchAll(/<button data-view="(\w+)"/g)].map((m) => m[1]);
    expect(navOrder).toEqual(views);
  });

  for (const view of views) {
    it(`${view}: section, nav button and a unique keyboard shortcut`, () => {
      expect(htmlIds.has(`view-${view}`)).toBe(true);
      expect(html).toContain(`data-view="${view}"`);
      const key = shortcuts[view];
      expect(key).toBeTruthy();
      // The <kbd> hint in the sidebar shows the key the map actually binds.
      expect(html).toMatch(
        new RegExp(`data-view="${view}"[^\\n]*<kbd>${key!.toUpperCase()}</kbd>`),
      );
      expect(Object.values(shortcuts).filter((k) => k === key)).toHaveLength(1);
    });
  }

  it("every element id app.js looks up exists in index.html", () => {
    const wanted = [...appJs.matchAll(/\$\("#([A-Za-z][\w-]*)"\)/g)].map((m) => m[1]!);
    const missing = [...new Set(wanted)].filter(
      // Some elements (topbar buttons, the page-size select) are created by
      // app.js itself at runtime — those carry their id="…" in app.js.
      (id) => !htmlIds.has(id) && !appJs.includes(`id="${id}"`),
    );
    expect(missing).toEqual([]);
  });
});
