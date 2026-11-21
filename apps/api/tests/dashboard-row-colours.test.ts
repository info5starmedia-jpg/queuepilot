import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TabStatePatchSchema } from "@queuepilot/contracts";

/**
 * Tab View row colours are picked by NAME from a fixed palette — never by
 * typing a hex code. The stored field is unchanged (tab-state `colour`), so
 * a legacy or hand-set value still renders and is still offered as current.
 */

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "dashboard");
const appJs = readFileSync(join(DIR, "app.js"), "utf8");
const css = readFileSync(join(DIR, "styles.css"), "utf8");

/** The ROW_COLOURS array as the console defines it. */
const palette = new Function(
  `${appJs.slice(appJs.indexOf("const ROW_COLOURS = ["), appJs.indexOf("];", appJs.indexOf("const ROW_COLOURS = [")) + 2)}; return ROW_COLOURS;`,
)() as { name: string; hex: string }[];

describe("row colour palette", () => {
  it("offers exactly the nine named colours the owner asked for, in order", () => {
    expect(palette.map((c) => c.name)).toEqual([
      "Fluorescent Red",
      "Green",
      "Blue",
      "Gold",
      "Purple",
      "Yellow",
      "Sky Blue",
      "Pink",
      "Orange",
    ]);
  });

  it("every name maps to a distinct value the stored field accepts", () => {
    const hexes = palette.map((c) => c.hex);
    expect(new Set(hexes).size).toBe(9);
    for (const hex of hexes) {
      expect(hex).toMatch(/^#[0-9a-f]{6}$/); // lowercase, so the name lookup matches
      expect(TabStatePatchSchema.safeParse({ colour: hex }).success).toBe(true);
    }
  });

  it("no hex prompt remains — the 🎨 button opens the palette", () => {
    expect(appJs).not.toContain("Row colour as #rrggbb");
    expect(appJs).toContain("openColourMenu(id, btn.dataset.colour || null");
  });

  it("picking a colour PATCHes tab-state; 'No colour' clears it", () => {
    const start = appJs.indexOf("function openColourMenu(");
    const body = appJs.slice(start, appJs.indexOf("\n}\n", start));
    expect(body).toContain('b.dataset.colour === "" ? null : b.dataset.colour');
    expect(body).toContain("/tab-state`, { method: \"PATCH\", body: JSON.stringify({ colour }) }");
    expect(body).toContain(">No colour<");
    expect(TabStatePatchSchema.safeParse({ colour: null }).success).toBe(true);
  });

  it("a legacy or hand-set value still renders and is offered as the current choice", () => {
    const start = appJs.indexOf("function openColourMenu(");
    const body = appJs.slice(start, appJs.indexOf("\n}\n", start));
    // Anything not in the palette is kept and shown as "Current (…)".
    expect(body).toContain("const legacy = cur && !rowColourName(cur) ? cur : null;");
    expect(body).toContain("Current (");
    // The row border still paints straight from the stored value.
    expect(appJs).toContain('border-left:4px solid ${esc(r.state.colour)}');
  });

  it("rowColourName resolves palette values and leaves custom ones unnamed", () => {
    const rowColourName = new Function(
      `${appJs.slice(appJs.indexOf("const ROW_COLOURS = ["), appJs.indexOf("];", appJs.indexOf("const ROW_COLOURS = [")) + 2)}
       ${appJs.slice(appJs.indexOf("function rowColourName("), appJs.indexOf("\n}\n", appJs.indexOf("function rowColourName(")) + 2)}
       ; return rowColourName;`,
    )() as (hex: string | null) => string | null;

    expect(rowColourName(palette[0]!.hex)).toBe("Fluorescent Red");
    expect(rowColourName(palette[0]!.hex.toUpperCase())).toBe("Fluorescent Red"); // case-insensitive
    expect(rowColourName("#123456")).toBeNull(); // legacy value: no name, still stored
    expect(rowColourName(null)).toBeNull();
  });

  it("the picker renders a swatch per colour", () => {
    expect(appJs).toContain('<span class="swatch"');
    expect(css).toContain(".ctx-menu .swatch");
  });
});
