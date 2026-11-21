import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Row hover actions (📋 copy / ✏️ edit). The dashboard is zero-build vanilla
 * JS, so wiring is checked from source text and the pure helpers are
 * evaluated in isolation.
 */

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "dashboard");
const appJs = readFileSync(join(DIR, "app.js"), "utf8");
const html = readFileSync(join(DIR, "index.html"), "utf8");
const css = readFileSync(join(DIR, "styles.css"), "utf8");

/** Pull a top-level `function name(...) {...}` out of app.js and evaluate it. */
function fn<T>(name: string): T {
  const start = appJs.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const end = appJs.indexOf("\n}\n", start);
  return new Function(`${appJs.slice(start, end + 2)}; return ${name};`)() as T;
}

describe("row hover actions", () => {
  it("profile, proxy and email rows render the hover cell and wire it", () => {
    const wired = [...appJs.matchAll(/wireHoverActions\(tr, \{\s*copy: \(\) =>/g)];
    expect(wired).toHaveLength(3);
    expect(appJs).toContain('edit: () => onProfileAction(p.id, "edit", p)');
    expect(appJs).toContain("edit: () => openProxyEdit(p)");
    expect(appJs).toContain("copy: () => a.email");
  });

  it("the profile list loads proxy details itself, so the row copy has host:port before the Proxies view opens", () => {
    const start = appJs.indexOf("async function loadProfiles(");
    const body = appJs.slice(start, appJs.indexOf("\n}\n", start));
    expect(body).toContain('api("/proxies")');
    expect(body).toContain("proxyById = new Map(");
  });

  it("the profile and proxy tables reserve a header cell for the hover column", () => {
    expect(html.match(/<th class="hover-col"><\/th>/g)).toHaveLength(2);
  });

  it("icons fade in on hover without changing the column width, and show on touch", () => {
    expect(css).toMatch(/\.hover-actions \{[^}]*opacity: 0/);
    expect(css).toMatch(/tr:hover \.hover-actions/);
    expect(css).toMatch(/@media \(hover: none\) \{ \.hover-actions \{ opacity: 1; \} \}/);
    expect(css).toMatch(/td\.hover-col \{ width: 64px/);
  });

  it("the values a row shows — profile proxy, proxy endpoint — carry their own copy icon", () => {
    // The profiles table has no email column (owner's layout), so Copy email
    // for a profile lives in the right-click menu; see dashboard-profile-menu.
    expect(appJs).toContain('<td class="mono">${esc(proxyText)}${cellCopy(proxy ? proxyText : null, "proxy")}</td>');
    expect(appJs).toContain('${cellCopy(`${p.host}:${p.port}`, "endpoint")}');
    // Delegated, so the icons survive the frequent table re-renders.
    expect(appJs).toMatch(/for \(const sel of \["#profiles-table", "#proxies"\]\)/);
    expect(appJs).toContain('e.target.closest?.(".cell-copy")');
    expect(appJs).toContain("copyText(b.dataset.copy)");
  });

  it("a cell copy icon renders only when there is a value, and is escaped", () => {
    // cellCopy calls esc(); inject it rather than pulling in the whole file.
    const start = appJs.indexOf("function cellCopy(");
    expect(start).toBeGreaterThan(-1);
    const src = appJs.slice(start, appJs.indexOf("\n}\n", start) + 2);
    const cellCopy = new Function("esc", `${src}; return cellCopy;`)((s: unknown) =>
      String(s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;"),
    ) as (v: string | null, l: string) => string;

    expect(cellCopy(null, "proxy")).toBe("");
    expect(cellCopy("", "proxy")).toBe("");
    const icon = cellCopy("1.2.3.4:8080", "proxy");
    expect(icon).toContain('data-copy="1.2.3.4:8080"');
    expect(icon).toContain('title="copy proxy"');
    // The value and the label both go through esc() in the source.
    expect(appJs).toContain('data-copy="${esc(value)}"');
    expect(cellCopy('a"b', "proxy")).toContain("&quot;");
  });

  it("the copy icon fades in with the row and stays visible on touch", () => {
    expect(css).toMatch(/\.cell-copy \{[^}]*opacity: 0/);
    expect(css).toMatch(/tr:hover \.cell-copy/);
    expect(css).toMatch(/@media \(hover: none\) \{ \.cell-copy \{ opacity: 0\.75; \} \}/);
  });

  it("copy falls back to execCommand when the Clipboard API is unavailable", () => {
    expect(appJs).toContain("navigator.clipboard.writeText(text)");
    expect(appJs).toContain('document.execCommand("copy")');
  });

  it("the proxy connection string omits credentials when there are none and never carries a password", () => {
    const conn = fn<(p: Record<string, unknown>) => string>("proxyConnString");
    expect(conn({ type: "http", host: "1.2.3.4", port: 8080, username: null })).toBe("http://1.2.3.4:8080");
    expect(conn({ type: "socks5", host: "h.example", port: 1080, username: "u", password: "pw" })).toBe(
      "socks5://u@h.example:1080",
    );
  });

  it("the proxy edit drawer PATCHes the existing endpoint and keeps a blank password", () => {
    expect(html).toContain('id="proxy-edit-modal"');
    expect(appJs).toContain("await api(`/proxies/${proxyEditId}`, { method: \"PATCH\"");
    expect(appJs).toContain('...(password !== "" ? { password } : {})');
  });
});
