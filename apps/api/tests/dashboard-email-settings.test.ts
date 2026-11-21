import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SETTINGS_SECTIONS as API_SECTIONS } from "@queuepilot/contracts";

/**
 * Settings → Email (IMAP): the email-accounts card has its own nav section
 * (custom card, no key/value fields); Integrations keeps Google + the
 * providers note and points at it. Checked from source text — the
 * dashboard is zero-build vanilla JS.
 */

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "dashboard");
const appJs = readFileSync(join(DIR, "app.js"), "utf8");

const sections = JSON.parse(/const SETTINGS_SECTIONS = (\[[^\]]+\]);/.exec(appJs)![1]!) as string[];

/** Body of renderIntegrationsInfo, which picks each section's custom card. */
const integrationsInfo = (() => {
  const start = appJs.indexOf("function renderIntegrationsInfo(");
  return appJs.slice(start, appJs.indexOf("\n}\n", start));
})();

describe("Settings → Email (IMAP)", () => {
  it("nav order is General, Engine, Launch, Email (IMAP), Integrations, Automation, Agent, Team", () => {
    expect(sections).toEqual(["general", "engine", "launch", "email", "integrations", "automation", "agent", "team"]);
    expect(appJs).toContain('const SETTINGS_LABELS = { email: "Email (IMAP)" };');
    expect(appJs).toContain("b.textContent = SETTINGS_LABELS[s] ?? s;");
  });

  it("every nav section except email is a real API settings section; email has no key/value fields", () => {
    const apiSections: readonly string[] = API_SECTIONS;
    expect(sections.filter((s) => s !== "email").every((s) => apiSections.includes(s))).toBe(true);
    expect(apiSections).not.toContain("email");
    expect(appJs).toContain("SETTINGS_FIELDS.email = [];");
  });

  it("the email section renders the accounts card; integrations only points to it", () => {
    expect(integrationsInfo).toMatch(/settingsSection === "email"\) \{\s*renderEmailAccountsCard\(box\)/);
    expect(integrationsInfo).toContain("Email accounts live under");
    expect(integrationsInfo).not.toContain("email-account-form");
  });

  it("the card has the tidy table columns, the hint above the form and the four fields", () => {
    const start = appJs.indexOf("function renderEmailAccountsCard(");
    const card = appJs.slice(start, appJs.indexOf("\n}\n", start));
    expect(card).toContain("<th>Email</th><th>Server</th><th>Password</th><th>Actions</th>");
    expect(card.indexOf("app password")).toBeLessThan(card.indexOf('<form id="email-account-form"'));
    for (const id of ["email-account-email", "email-account-password", "email-account-host", "email-account-port"]) {
      expect(card).toContain(`id="${id}"`);
    }
    expect(card).toContain('class="email-form"');
  });

  it("the AYCD Inbox card lives here, next to the mail accounts — not under Integrations", () => {
    const emailStart = appJs.indexOf("function renderEmailAccountsCard(");
    const emailCard = appJs.slice(emailStart, appJs.indexOf("\n}\n", emailStart));
    // Key slot, Test and the usage notes moved wholesale.
    expect(emailCard).toContain('id="aycd-card"');
    for (const id of ["aycd-key", "aycd-test", "aycd-remove", "aycd-state", "aycd-status"]) {
      expect(emailCard).toContain(`id="${id}"`);
    }
    expect(emailCard).toContain("Inbox → Mail → IMAP Server"); // usage notes came along
    expect(emailCard).toContain("wireAycdCard()");

    // Integrations keeps Discord (and room for more), but no longer AYCD.
    const intStart = appJs.indexOf("function integrationCardsHtml(");
    const intCard = appJs.slice(intStart, appJs.indexOf("\n}\n", intStart));
    expect(intCard).toContain('id="discord-card"');
    expect(intCard).not.toContain("aycd");

    // Exactly one of each — the card was moved, not copied.
    expect(appJs.match(/id="aycd-card"/g)).toHaveLength(1);
    expect(appJs.match(/wireAycdCard\(\);/g)).toHaveLength(1);
  });

  it("the AYCD move is UI-only: the same /integrations/aycd routes are called", () => {
    const start = appJs.indexOf("function wireAycdCard(");
    const body = appJs.slice(start, appJs.indexOf("\n}\n", start));
    expect(body).toContain('api("/integrations/aycd")');
    expect(body).toContain('api("/integrations/aycd", { method: "PUT"');
    expect(body).toContain('api("/integrations/aycd", { method: "DELETE" })');
    expect(body).toContain('api("/integrations/aycd/verify", { method: "POST" })');
  });

  it("rows carry Test, Copy and Remove, a TLS badge, and a reserved test-result line", () => {
    expect(appJs).toMatch(/data-act="test">Test<\/button><button[^>]*data-hover="copy"[^>]*>📋 Copy<\/button><button[^>]*data-act="remove"/);
    expect(appJs).toContain('<span class="tag">TLS</span>');
    expect(appJs).toContain('<span class="mono email-test-out" data-out></span>');
    const css = readFileSync(join(DIR, "styles.css"), "utf8");
    expect(css).toMatch(/\.email-test-out \{ display: block; min-height: 16px/);
  });
});
