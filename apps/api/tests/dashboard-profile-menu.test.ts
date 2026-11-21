import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Right-click menu on a profile name (static wiring guard; the behaviour is
 * driven in a real browser by scripts/console-smoke.mjs). The console is
 * zero-build vanilla JS, so this is checked from source text like
 * dashboard-views.test.ts.
 */

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "dashboard");
const appJs = readFileSync(join(DIR, "app.js"), "utf8");
const html = readFileSync(join(DIR, "index.html"), "utf8");

/** The body of a top-level function in app.js. */
function fnBody(name: string): string {
  const start = appJs.search(new RegExp(`^(async )?function ${name}\\(`, "m"));
  expect(start, `function ${name}`).toBeGreaterThan(-1);
  const next = appJs.slice(start + 1).search(/^(async )?function |^\$\(|^document\.|^window\./m);
  return appJs.slice(start, next === -1 ? undefined : start + 1 + next);
}

describe("profile right-click menu", () => {
  it("opens from a right-click on a profile name (delegated on the table, per row)", () => {
    expect(appJs).toMatch(/\$\("#profiles-table"\)\.addEventListener\("contextmenu"/);
    expect(appJs).toMatch(/closest\?\.\("\.pname"\)/);
    expect(appJs).toMatch(/allProfiles\.find\(\(x\) => x\.id === name\.closest\("tr"\)\?\.dataset\.id\)/);
  });

  it("has exactly Launch, Stop, Run warmer, Edit note, Copy email, Copy proxy — in that order", () => {
    const menu = fnBody("openProfileMenu");
    const items = [...menu.matchAll(/data-ctx="([a-z-]+)"/g)].map((m) => m[1]);
    expect(items).toEqual(["start", "stop", "warmers", "note", "copy-email", "copy-proxy"]);
  });

  it("each action calls the right endpoint or helper", () => {
    const click = fnBody("onProfileMenuClick");
    expect(click).toMatch(/act === "start" \|\| act === "stop"\) return onProfileAction\(p\.id, act, p\)/);
    expect(click).toMatch(/copy-email.*copyText\(p\.email\)/s);
    expect(click).toMatch(/copy-proxy.*profileProxyText\(p\).*copyText\(text\)/s);
    expect(click).toMatch(/note.*openNoteModal\(p\)/s);
    const warm = fnBody("runWarmerOn");
    expect(warm).toContain("/profiles/${p.id}/warmup/persona");
    expect(warm).toContain("/warmups/${encodeURIComponent(warmerId)}/run");
    expect(warm).toContain("keepRunning: true");
    expect(warm).toContain("stopAfter: false");
    const sub = fnBody("showWarmerSubmenu");
    expect(sub).toContain('api("/warmups")');
    expect(sub).toContain('api("/warmups/personas")');
  });

  it("Copy proxy copies host:port only — never a password", () => {
    const proxyText = fnBody("profileProxyText");
    expect(proxyText).toContain("`${proxy.host}:${proxy.port}`");
    expect(proxyText).not.toMatch(/password/i);
  });

  it("Edit note saves the profile's own notes (PATCH /profiles/:id), not the Log-note CSV", () => {
    expect(appJs).toMatch(/api\(`\/profiles\/\$\{id\}`, \{ method: "PATCH", body: JSON\.stringify\(\{ notes: \$\("#note-modal-text"\)\.value \}\) \}\)/);
    expect(fnBody("openNoteModal")).toContain("api(`/profiles/${p.id}`)");
    for (const id of ["note-modal", "note-modal-title", "note-modal-text", "note-modal-save", "note-modal-close", "note-modal-status"]) {
      expect(html).toContain(`id="${id}"`);
    }
    const noteSection = appJs.slice(appJs.indexOf("profile note modal"));
    expect(noteSection).not.toContain("log-note");
  });
});
