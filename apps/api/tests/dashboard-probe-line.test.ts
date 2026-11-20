import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Proxy probe status line (profile form + proxy table). The renderer is
 * pure, so it is lifted out of app.js and evaluated against fixtures.
 */

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "dashboard");
const appJs = readFileSync(join(DIR, "app.js"), "utf8");
const html = readFileSync(join(DIR, "index.html"), "utf8");

function source(name: string): string {
  const start = appJs.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  return appJs.slice(start, appJs.indexOf("\n}\n", start) + 2);
}
const escSrc = /const esc = [\s\S]*?\n {2}\);\n/.exec(appJs)![0];
const probeLineHtml = new Function(
  `${escSrc}${source("flagEmoji")}${source("probeLineHtml")}; return probeLineHtml;`,
)() as (p: unknown) => string;

describe("proxy probe status line", () => {
  it("ok: flag, country · city · timezone · latency, and a Re-test link", () => {
    const line = probeLineHtml({
      ok: true,
      error: null,
      country: "Germany",
      countryCode: "DE",
      city: "Berlin",
      timezone: "Europe/Berlin",
      latencyMs: 243,
    });
    expect(line).toContain("🟢 🇩🇪 Germany · Berlin · Europe/Berlin · 243 ms");
    expect(line).toContain(">Re-test</a>");
  });

  it("fail: the error, escaped, with Re-test", () => {
    const line = probeLineHtml({ ok: false, error: "<b>407</b>" });
    expect(line).toContain("🔴 Test failed: &lt;b&gt;407&lt;/b&gt;");
    expect(line).toContain(">Re-test</a>");
  });

  it("untested: Not tested yet with Test now", () => {
    expect(probeLineHtml(null)).toBe('⚪ Not tested yet <a href="#" data-probe-test>Test now</a>');
  });

  it("is wired under the profile form's proxy picker and in the proxy table", () => {
    expect(html).toMatch(/<select id="pf-proxy">[\s\S]{0,80}<\/label>\s*<div id="pf-proxy-status"/);
    expect(appJs).toContain('renderProbeLine($("#pf-proxy-status"), sel.value)');
    expect(appJs).toContain('renderProbeLine(tr.querySelector("[data-out]"), p.id)');
    // A re-test updates the line in place from the endpoint's lastProbe.
    expect(appJs).toContain("if (p) p.lastProbe = r.lastProbe;");
  });
});
