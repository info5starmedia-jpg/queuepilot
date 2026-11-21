import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Task 7: the owner creates a team member directly (email + temporary
 * password), and a signed-in member can change their own password. Checked
 * from source text — the dashboard is zero-build vanilla JS; the live
 * round-trip against a real team server runs in console-smoke.
 */

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "dashboard");
const appJs = readFileSync(join(DIR, "app.js"), "utf8");

function fnBody(name: string): string {
  const start = appJs.indexOf(`function ${name}(`);
  expect(start, `function ${name}`).toBeGreaterThan(-1);
  return appJs.slice(start, appJs.indexOf("\n}\n", start));
}

describe("console: team member creation + password change", () => {
  it("the owner panel has an 'Add a member directly' form that posts email + password", () => {
    const panel = fnBody("renderTeamPanel");
    expect(panel).toContain('id="team-create-form"');
    for (const id of ["team-create-email", "team-create-name", "team-create-password"]) {
      expect(panel).toContain(`id="${id}"`);
    }
    expect(panel).toContain('api("/team/members", {\n        method: "POST"');
    expect(panel).toContain("email, password, ...(displayName ? { displayName } : {})");
  });

  it("the temporary password is shown exactly once, then never again", () => {
    const panel = fnBody("renderTeamPanel");
    const start = panel.indexOf('body.querySelector("#team-create-form")?.addEventListener("submit"');
    const handler = panel.slice(start, panel.indexOf("\n  });", start));
    // Refresh the panel FIRST (fresh member list + a fresh, empty #team-create-out),
    // THEN write the one-time message — same ordering bug class the invite
    // flow already avoids. Getting this backwards means renderTeamPanel()
    // wipes the password message right after showing it.
    const refreshAt = handler.indexOf("await renderTeamPanel()");
    const showAt = handler.indexOf('$("#team-create-out").innerHTML');
    expect(refreshAt).toBeGreaterThan(-1);
    expect(showAt).toBeGreaterThan(refreshAt);
    expect(handler).toContain("esc(password)"); // the plaintext only ever goes through esc(), never stored
    expect(handler).toContain("team-create-copy");
  });

  it("the created-member response can never carry the password back (server contract via the dashboard call)", () => {
    const panel = fnBody("renderTeamPanel");
    // The dashboard reads only r.account.* from the response — never r.password or similar.
    expect(panel).toMatch(/r\.account\.displayName/);
    expect(panel).toMatch(/r\.account\.email/);
    expect(panel).not.toMatch(/r\.password\b/);
  });

  it("the signed-in team card has a Change password form posting to /team/password", () => {
    const start = appJs.indexOf("function renderTeamCard(");
    const card = appJs.slice(start, appJs.indexOf("\n}\n", start));
    expect(card).toContain('id="team-password-form"');
    expect(card).toContain('id="team-password-current"');
    expect(card).toContain('id="team-password-new"');
    expect(card).toContain('api("/team/password", {\n        method: "POST"');
    expect(card).toContain("currentPassword: $(\"#team-password-current\").value");
    expect(card).toContain("newPassword: $(\"#team-password-new\").value");
    // Plain-text server errors (e.g. "current password is wrong") land in
    // the status line — via the draft, which survives settings re-renders
    // (an SSE wipe mid-request must not eat the message).
    expect(card).toContain("teamPwDraft.status = err.message;");
    expect(card).toContain("paintTeamPw();");
    expect(appJs).toContain("let teamPwDraft = { current: \"\", next: \"\", status: \"\" };");
  });
});
