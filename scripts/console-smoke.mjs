/**
 * Console smoke — drives the REAL dashboard in a headless Chromium and
 * clicks its buttons, the way a team member does.
 *
 * Why it exists: from v0.8.0 to v0.16.4 every body-less console button
 * (profile Delete/Stop, proxy test, provider refresh, tab close) answered
 * HTTP 500, and 600+ green tests never noticed — they all talk to the API
 * directly. This phase loads the dashboard page and runs its own handlers,
 * so a broken button fails here.
 *
 * Zero dependencies: a Chromium-family browser is launched headless and
 * driven over the DevTools protocol with Node's built-in WebSocket. Browser
 * resolution: QP_SMOKE_BROWSER, else the newest installed fury-core engine,
 * else Microsoft Edge, else Google Chrome. No browser = the phase reports
 * SKIP (never a pass).
 *
 * Used by e2e-smoke.mjs: runConsoleSmoke({ base, ok }).
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import net from "node:net";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

function findBrowser() {
  if (process.env.QP_SMOKE_BROWSER) return process.env.QP_SMOKE_BROWSER;
  const furyRoot = path.join(homedir(), ".queuepilot", "engines", "fury-core");
  if (existsSync(furyRoot)) {
    const versions = readdirSync(furyRoot).sort().reverse();
    for (const v of versions) {
      const exe = path.join(furyRoot, v, "windows-x64", "Fury", "chrome.exe");
      if (existsSync(exe)) return exe;
    }
  }
  const candidates = [
    path.join(process.env["ProgramFiles(x86)"] ?? "", "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(process.env.ProgramFiles ?? "", "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(process.env.ProgramFiles ?? "", "Google", "Chrome", "Application", "chrome.exe"),
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ];
  return candidates.find((c) => c && existsSync(c)) ?? null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs = 10_000, everyMs = 150) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    if (Date.now() > deadline) return undefined;
    await sleep(everyMs);
  }
}

/** Minimal CDP page client over the page's own WebSocket. */
async function connectPage(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 0;
  const pending = new Map();
  const exceptions = [];
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(String(ev.data));
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    } else if (m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails;
      exceptions.push(d.exception?.description ?? d.text ?? "exception");
    }
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", reject);
  });
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
      ws.send(JSON.stringify({ id, method, params }));
    });
  /** Evaluate in the page; returns the value (JSON-serialisable). */
  const evaluate = async (expression) => {
    const r = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "evaluate failed");
    return r.result.value;
  };
  return { call, evaluate, exceptions, close: () => ws.close() };
}

/** JS (page side) that clicks a profile row's action button by profile name. */
const clickRowAction = (name, act) => `(() => {
  const row = [...document.querySelectorAll('#profiles-table tbody tr')].find((tr) => tr.textContent.includes(${JSON.stringify(name)}));
  const btn = row && row.querySelector('[data-act="${act}"]');
  if (!btn) return false;
  btn.click();
  return true;
})()`;

export async function runConsoleSmoke({ base, ok, token }) {
  const exe = findBrowser();
  if (!exe) {
    console.log("  [SKIP] console smoke — no Chromium-family browser found (set QP_SMOKE_BROWSER)");
    return;
  }
  const profileDir = mkdtempSync(path.join(tmpdir(), "qp-console-smoke-"));
  const port = await freePort();
  const browser = spawn(
    exe,
    [
      "--headless=new",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "about:blank",
    ],
    { stdio: "ignore", windowsHide: true },
  );
  const api = async (method, url, body) => {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        // P0 audit item 3: the scratch API carries the auto-generated token.
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: res.status === 204 ? null : await res.json().catch(() => null) };
  };

  let page = null;
  try {
    const version = await waitFor(async () => {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      return r.ok ? r.json() : undefined;
    }, 20_000);
    ok(`headless browser up (${path.basename(exe)})`, Boolean(version), version ? version.Browser : "no DevTools endpoint");
    if (!version) return;

    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent("about:blank")}`, { method: "PUT" })).json();
    page = await connectPage(target.webSocketDebuggerUrl);
    await page.call("Runtime.enable");

    const name = `console-smoke-${Date.now()}`;
    const created = await api("POST", "/profiles", { name });
    const id = created.json?.id;
    // Right-click menu fixture: a second profile with an email and a launch
    // proxy. Its name must NOT contain `name` — row lookups match on
    // textContent.includes(), so a superstring would select the same row.
    const menuName = `ctxmenu-${Date.now()}`;
    const menuProfile = (await api("POST", "/profiles", { name: menuName })).json;
    const menuProxy = (await api("POST", "/proxies", { name: `${name}-px`, type: "http", host: "203.0.113.7", port: 8080 })).json;
    await api("PATCH", `/profiles/${menuProfile?.id}`, { email: "menu@example.com", proxyId: menuProxy?.id });

    await page.call("Page.navigate", { url: `${base}/` });
    const listed = await waitFor(() =>
      page.evaluate(`[...document.querySelectorAll('#profiles-table tbody tr')].some((tr) => tr.textContent.includes(${JSON.stringify(name)}))`),
    );
    ok("dashboard renders the profiles table", Boolean(listed));
    // Accept the console's confirm()/prompt() dialogs.
    await page.evaluate("window.confirm = () => true; window.prompt = () => null; true");

    // ▶ Start (POST with a body)
    await waitFor(() => page.evaluate(clickRowAction(name, "start")));
    const running = await waitFor(async () => (await api("GET", `/profiles/${id}`)).json?.status === "running");
    ok("console ▶ Start starts the profile", Boolean(running));

    // ■ Stop (body-less POST — the v0.8.0 bug class)
    const stopClicked = await waitFor(() => page.evaluate(clickRowAction(name, "stop")));
    const idle = await waitFor(async () => (await api("GET", `/profiles/${id}`)).json?.status === "idle");
    ok("console ■ Stop stops the profile", Boolean(stopClicked && idle));

    // ---- Right-click menu on a profile name ----
    // Record the page's own API calls and the clipboard.
    await page.evaluate(`(() => {
      window.__calls = [];
      const realFetch = window.fetch.bind(window);
      window.fetch = (u, o = {}) => { window.__calls.push((o.method || "GET").toUpperCase() + " " + String(u)); return realFetch(u, o); };
      window.__clip = [];
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t) => { window.__clip.push(t); } } });
      return true;
    })()`);
    const rightClick = (n) => `(() => {
      const row = [...document.querySelectorAll('#profiles-table tbody tr')].find((tr) => tr.textContent.includes(${JSON.stringify(n)}));
      const el = row && row.querySelector('.pname');
      if (!el) return false;
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 160, clientY: 160 }));
      return document.querySelector('#profile-menu')?.dataset.profile ?? false;
    })()`;
    const menuClick = (sel) => `(() => { const b = document.querySelector('#profile-menu ${sel}'); if (!b || b.disabled) return false; b.click(); return true; })()`;
    const called = (frag) => page.evaluate(`window.__calls.some((c) => c.includes(${JSON.stringify(frag)}))`);
    const mp = menuProfile?.id;
    await waitFor(() => page.evaluate(`[...document.querySelectorAll('#profiles-table tbody tr')].some((tr) => tr.textContent.includes(${JSON.stringify(menuName)}))`));
    const menuFor = [await waitFor(() => page.evaluate(rightClick(name))), await page.evaluate(rightClick(menuName))];
    ok("right-click opens the menu for the clicked row (per row)", menuFor[0] === id && menuFor[1] === mp, menuFor.join(" / "));
    const items = await page.evaluate(`[...document.querySelectorAll('#profile-menu > button, #profile-menu .ctx-sub > button')].map((b) => b.textContent.trim())`);
    ok("menu items: Launch, Stop, Run warmer, Edit note, Copy email, Copy proxy",
      JSON.stringify(items) === JSON.stringify(["▶ Launch", "■ Stop", "♨ Run warmer ▸", "✎ Edit note…", "📋 Copy email", "📋 Copy proxy"]), JSON.stringify(items));
    await page.evaluate(menuClick('[data-ctx="copy-email"]'));
    await page.evaluate(rightClick(menuName));
    await page.evaluate(menuClick('[data-ctx="copy-proxy"]'));
    const clip = await waitFor(() => page.evaluate("window.__clip.length === 2 && window.__clip"));
    ok("Copy email / Copy proxy put the email and host:port on the clipboard",
      JSON.stringify(clip) === JSON.stringify(["menu@example.com", "203.0.113.7:8080"]), JSON.stringify(clip));
    // Hover copy icon on the value the row actually shows (the profile's proxy).
    const cellCopied = await page.evaluate(`(() => {
      window.__clip.length = 0;
      const row = [...document.querySelectorAll('#profiles-table tbody tr')].find((tr) => tr.textContent.includes(${JSON.stringify(menuName)}));
      const btn = row && row.querySelector('.cell-copy');
      if (!btn) return "no icon";
      btn.click();
      return window.__clip[0] ?? "nothing copied";
    })()`);
    ok("hover copy icon on the proxy cell copies host:port", cellCopied === "203.0.113.7:8080", String(cellCopied));

    // Drop the fixture proxy now: the proxies phase below asserts an exact
    // count. Detach it first — the service refuses to delete a proxy that a
    // profile still references (409 CONFLICT).
    await api("PATCH", `/profiles/${mp}`, { proxyId: null });
    await api("DELETE", `/proxies/${menuProxy?.id}`);
    await waitFor(async () => ((await api("GET", "/proxies")).json?.proxies ?? []).every((p) => p.id !== menuProxy?.id));
    // Launch/Stop/warmer on the proxy-less profile (no live geo lookup through a test proxy).
    await page.evaluate(rightClick(name));
    await page.evaluate(menuClick('[data-ctx="start"]'));
    const menuRunning = await waitFor(async () => (await api("GET", `/profiles/${id}`)).json?.status === "running");
    ok("menu Launch calls POST /profiles/:id/start", Boolean(menuRunning && (await called(`POST /profiles/${id}/start`))));
    await waitFor(() => page.evaluate(`[...document.querySelectorAll('#profiles-table tbody tr')].some((tr) => tr.textContent.includes(${JSON.stringify(name)}) && tr.textContent.includes("RUNNING"))`));

    // ---- Tab View row colour: pick by name, save, reload ----
    // (Tab View lists running profiles, so this runs while the profile is up.)
    await page.evaluate(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "n" })); true`);
    const tabRow = await waitFor(() =>
      page.evaluate(`!document.querySelector('#view-tabview').hidden && [...document.querySelectorAll('#tabview-table tbody tr')].some((tr) => tr.querySelector('[data-tv="colour"][data-id="${id}"]'))`),
    );
    await page.evaluate(`document.querySelector('[data-tv="colour"][data-id="${id}"]').click(); true`);
    const names = await waitFor(() =>
      page.evaluate(`(() => { const m = document.querySelector('#colour-menu'); return m ? [...m.querySelectorAll('[data-colour]')].map((b) => b.textContent.replace(" ✓", "").trim()) : undefined; })()`),
    );
    ok("row colour picker lists the nine named colours (no hex prompt)",
      Boolean(tabRow) && JSON.stringify(names) === JSON.stringify(["Fluorescent Red", "Green", "Blue", "Gold", "Purple", "Yellow", "Sky Blue", "Pink", "Orange", "No colour"]),
      JSON.stringify(names));
    await page.evaluate(`[...document.querySelectorAll('#colour-menu [data-colour]')].find((b) => b.textContent.includes("Sky Blue")).click(); true`);
    const stored = await waitFor(async () => (await api("GET", `/profiles/${id}/tab-state`)).json?.colour);
    const painted = await waitFor(() =>
      page.evaluate(`(() => { const b = document.querySelector('[data-tv="colour"][data-id="${id}"]'); return b && b.closest('tr').getAttribute('style') || undefined; })()`),
    );
    ok("picking Sky Blue stores it and repaints the row", stored === "#7fdbff" && String(painted).includes("#7fdbff"), `${stored} / ${painted}`);
    await page.evaluate(`document.querySelector('[data-tv="colour"][data-id="${id}"]').click(); true`);
    const ticked = await waitFor(() =>
      page.evaluate(`(() => { const b = [...document.querySelectorAll('#colour-menu [data-colour]')].find((x) => x.textContent.includes("Sky Blue")); return b ? b.textContent.trim() : undefined; })()`),
    );
    ok("re-opening the picker ticks the saved colour", String(ticked).endsWith("✓"), String(ticked));
    await page.evaluate(`document.querySelector('#colour-menu [data-colour=""]').click(); true`);
    const cleared = await waitFor(async () => (await api("GET", `/profiles/${id}/tab-state`)).json?.colour === null);
    ok("'No colour' clears the stored value", Boolean(cleared));
    await page.evaluate(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "p" })); true`);
    await waitFor(() => page.evaluate(`!document.querySelector('#view-profiles').hidden`));

    await page.evaluate(rightClick(name));
    await page.evaluate(menuClick('[data-ctx="stop"]'));
    const menuIdle = await waitFor(async () => (await api("GET", `/profiles/${id}`)).json?.status === "idle");
    ok("menu Stop calls POST /profiles/:id/stop", Boolean(menuIdle && (await called(`POST /profiles/${id}/stop`))));
    await page.evaluate(rightClick(menuName));
    await page.evaluate(menuClick('[data-ctx="note"]'));
    await waitFor(() => page.evaluate(`!document.querySelector('#note-modal').hidden && document.querySelector('#note-modal-status').textContent === ""`));
    await page.evaluate(`document.querySelector('#note-modal-text').value = "smoke note — line 1"; document.querySelector('#note-modal-save').click(); true`);
    const noteSaved = await waitFor(async () => (await api("GET", `/profiles/${mp}`)).json?.notes === "smoke note — line 1");
    await waitFor(() => page.evaluate(`document.querySelector('#note-modal').hidden`));
    await page.evaluate(rightClick(menuName));
    await page.evaluate(menuClick('[data-ctx="note"]'));
    const reopened = await waitFor(() => page.evaluate(`document.querySelector('#note-modal-text').value === "smoke note — line 1"`));
    ok("Edit note saves via PATCH /profiles/:id and re-opens with the saved note",
      Boolean(noteSaved && reopened && (await called(`PATCH /profiles/${mp}`))));
    await page.evaluate(`document.querySelector('#note-modal-close').click(); true`);
    const menuRecipe = (await api("POST", "/warmups", { name: `${name}-menu-recipe`, steps: [{ url: "https://example.com/", dwellMs: 1000 }] })).json;
    await waitFor(() => page.evaluate(`[...document.querySelectorAll('#profiles-table tbody tr')].some((tr) => tr.textContent.includes(${JSON.stringify(name)}) && !tr.textContent.includes("RUNNING"))`));
    await page.evaluate(rightClick(name));
    await page.evaluate(menuClick('[data-ctx="warmers"]'));
    const listedWarmer = await waitFor(() => page.evaluate(`[...document.querySelectorAll('#profile-menu [data-warmer="recipe"]')].some((b) => b.textContent.includes(${JSON.stringify(`${name}-menu-recipe`)}))`));
    await page.evaluate(`(() => { const b = [...document.querySelectorAll('#profile-menu [data-warmer="recipe"]')].find((x) => x.textContent.includes(${JSON.stringify(`${name}-menu-recipe`)})); if (b) b.click(); return true; })()`);
    const warmerCalled = await waitFor(() => called(`POST /warmups/${menuRecipe?.id}/run`));
    ok("Run warmer lists recorded recipes and launches the profile with the picked one", Boolean(listedWarmer && warmerCalled));
    // The recipe run holds its request until done; wait for it, then leave the profile idle for the Delete step.
    await waitFor(async () => (await api("GET", `/profiles/${id}`)).json?.status === "running", 15_000);
    await waitFor(() => page.evaluate(`window.__calls.length > 0 && true`));
    await sleep(2_500);
    await api("POST", `/profiles/${id}/stop`);
    await waitFor(async () => (await api("GET", `/profiles/${id}`)).json?.status === "idle");
    await api("DELETE", `/profiles/${mp}`);
    await api("DELETE", `/warmups/${menuRecipe?.id}`);

    // 🗑 Delete (body-less DELETE)
    const delClicked = await waitFor(() => page.evaluate(clickRowAction(name, "delete")));
    const deleted = await waitFor(async () => (await api("GET", `/profiles/${id}`)).status === 404);
    ok("console 🗑 Delete deletes the profile", Boolean(delClicked && deleted));

    // Warmups view: W shortcut + recipe Delete (body-less DELETE)
    const recipe = await api("POST", "/warmups", { name: `${name}-recipe`, steps: [{ url: "https://example.com/", dwellMs: 1000 }] });
    await page.evaluate(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "w" })); true`);
    const recipeRow = await waitFor(() =>
      page.evaluate(`!document.querySelector('#view-warmups').hidden && [...document.querySelectorAll('#warmups-table tbody tr')].some((tr) => tr.textContent.includes(${JSON.stringify(`${name}-recipe`)}))`),
    );
    ok("W opens Warmups and lists recipes", Boolean(recipeRow));
    await page.evaluate(`(() => {
      const row = [...document.querySelectorAll('#warmups-table tbody tr')].find((tr) => tr.textContent.includes(${JSON.stringify(`${name}-recipe`)}));
      row.querySelector('[data-act="delete"]').click();
      return true;
    })()`);
    const recipeGone = await waitFor(async () => (await api("GET", `/warmups/${recipe.json?.id}`)).status === 404);
    ok("console recipe Delete deletes the recipe", Boolean(recipeGone));

    // Profiles: header select-all -> "+ New group" (groups need members)
    const g1 = await api("POST", "/profiles", { name: `${name}-g1` });
    const g2 = await api("POST", "/profiles", { name: `${name}-g2` });
    // Created behind the console's back (API), so reload it like a user would.
    await page.call("Page.reload");
    await waitFor(() => page.evaluate(`[...document.querySelectorAll('#profiles-table tbody tr')].some((tr) => tr.textContent.includes(${JSON.stringify(`${name}-g2`)}))`));
    await page.evaluate("window.confirm = () => true; window.prompt = () => null; true");
    const selectedAll = await page.evaluate(`(() => {
      const box = document.querySelector('#profiles-select-all');
      box.checked = true;
      box.dispatchEvent(new Event('change'));
      return document.querySelector('#batch-count').textContent;
    })()`);
    const expected = (await api("GET", "/profiles")).json?.profiles?.length ?? -1;
    ok("profiles select-all selects every profile", selectedAll === `${expected} selected`, `${selectedAll} / ${expected}`);
    const groupName = `${name}-grp`;
    await page.evaluate(`window.prompt = () => ${JSON.stringify(groupName)}; document.querySelector('#new-group-chip').click(); true`);
    const grouped = await waitFor(async () => {
      const a = (await api("GET", `/profiles/${g1.json?.id}`)).json;
      const b = (await api("GET", `/profiles/${g2.json?.id}`)).json;
      return a?.group === groupName && b?.group === groupName;
    });
    ok("+ New group moves the selection into a new group", Boolean(grouped));
    await page.evaluate("window.prompt = () => null; true");

    // Proxies: paste two dummy loopback proxies, select all, delete selected
    await page.evaluate(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "x" })); true`);
    await page.evaluate(`(() => {
      document.querySelector('#proxy-add-open').click();
      document.querySelector('#proxy-add-lines').value = "smoke-a:127.0.0.1:9:user:pa:ss\\n127.0.0.2:9";
      document.querySelector('#proxy-add-go').click();
      return true;
    })()`);
    const added = await waitFor(async () => {
      const list = (await api("GET", "/proxies")).json?.proxies ?? [];
      return list.length === 2 ? list : undefined;
    });
    ok("pasting two lines adds two proxies", Boolean(added), added ? added.map((p) => p.name).join(", ") : "");
    const named = (added ?? []).find((p) => p.name === "smoke-a");
    ok("pasted line keeps its name, user and port", Boolean(named && named.username === "user" && named.port === 9));
    const summary = await waitFor(() => page.evaluate(`(() => { const t = document.querySelector('#proxy-add-status').textContent; return t.startsWith("2 added") ? t : undefined; })()`));
    ok("import dialog shows the added/skipped/errors summary", Boolean(summary), summary ?? "");
    // The table reloads after the import returns; select-all acts on what is rendered.
    await waitFor(() => page.evaluate(`document.querySelectorAll('#proxies tbody tr').length === 2`));
    await page.evaluate(`(() => {
      document.querySelector('#proxy-add-close').click();
      const box = document.querySelector('#proxies-select-all');
      box.checked = true;
      box.dispatchEvent(new Event('change'));
      return true;
    })()`);
    await waitFor(() => page.evaluate(`document.querySelector('#proxies-selected').textContent === "2 selected"`));
    // Proxy groups: move the selection into a new group via the toolbar.
    await page.evaluate(`(() => {
      window.prompt = () => "smoke-grp";
      document.querySelector('#proxies-move-group').value = "__new__";
      document.querySelector('#proxies-move').click();
      return true;
    })()`);
    const grouped2 = await waitFor(async () => {
      const list = (await api("GET", "/proxies?group=smoke-grp")).json?.proxies ?? [];
      return list.length === 2;
    });
    const tabActive = await waitFor(() => page.evaluate(`document.querySelector('#proxy-tabs .chip-tab.active')?.dataset.proxyGroup === "smoke-grp"`));
    ok("Move to group files the selection under a new proxy group", Boolean(grouped2 && tabActive));
    // Switching tabs keeps only selected rows the new tab still shows (All shows both).
    await page.evaluate(`(() => {
      const box = document.querySelector('#proxies-select-all');
      box.checked = true;
      box.dispatchEvent(new Event('change'));
      return true;
    })()`);
    await waitFor(() => page.evaluate(`document.querySelector('#proxies-selected').textContent === "2 selected"`));
    await page.evaluate(`(() => { const t = document.querySelector('#proxy-tabs [data-proxy-group="all"]'); t.click(); return true; })()`);
    const kept = await waitFor(() => page.evaluate(`document.querySelector('#proxies-selected').textContent === "2 selected" && document.querySelector('#proxy-tabs .chip-tab.active')?.dataset.proxyGroup === "all"`));
    ok("switching to All keeps rows that are still visible selected", Boolean(kept));
    await page.evaluate(`(() => {
      window.prompt = () => null;
      const box = document.querySelector('#proxies-select-all');
      box.checked = true;
      box.dispatchEvent(new Event('change'));
      return true;
    })()`);
    await waitFor(() => page.evaluate(`document.querySelector('#proxies-selected').textContent === "2 selected"`));
    await page.evaluate(`document.querySelector('#proxies-delete-selected').click(); true`);
    const emptied = await waitFor(async () => ((await api("GET", "/proxies")).json?.proxies ?? []).length === 0);
    ok("select-all + Delete selected removes every proxy", Boolean(emptied));

    // Settings → Integrations only points at Email (IMAP) now
    await page.evaluate(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "g" })); true`);
    const pointer = await waitFor(() => page.evaluate(`(() => {
      const b = document.querySelector('#settings-nav button[data-section="integrations"]');
      if (!b) return false;
      b.click();
      const info = document.querySelector('#integrations-info').textContent;
      return info.includes('Email accounts live under') && !document.querySelector('#email-account-form');
    })()`));
    ok("Settings → Integrations points to Email (IMAP) and no longer holds the account form", Boolean(pointer));

    // Settings → Email (IMAP): add an email account (dummy test values), see it, remove it
    const navOrder = await waitFor(() => page.evaluate(`(() => {
      const labels = [...document.querySelectorAll('#settings-nav button')].map((x) => x.textContent);
      const b = document.querySelector('#settings-nav button[data-section="email"]');
      if (!b) return false;
      b.click();
      return document.querySelector('#email-account-form') ? labels.join(",") : false;
    })()`));
    ok(
      "Settings nav lists Email (IMAP) between Launch and Integrations",
      navOrder === "general,engine,launch,Email (IMAP),integrations,automation,agent,team",
      String(navOrder),
    );
    await page.evaluate(`(() => {
      document.querySelector('#email-account-email').value = 'smoke-test@example.org';
      document.querySelector('#email-account-password').value = 'dummy-app-password';
      document.querySelector('#email-account-form').requestSubmit();
      return true;
    })()`);
    const account = await waitFor(async () => {
      const accounts = (await api("GET", "/email-accounts")).json?.accounts ?? [];
      return accounts.find((a) => a.email === "smoke-test@example.org");
    });
    const shown = await waitFor(() => page.evaluate(`document.querySelector('#email-accounts-table').textContent.includes('smoke-test@example.org')`));
    ok("Settings → Email (IMAP) adds an email account and lists it", Boolean(account && account.hasPassword && shown));
    await page.evaluate(`(() => {
      const row = [...document.querySelectorAll('#email-accounts-table tr')].find((tr) => tr.textContent.includes('smoke-test@example.org'));
      row.querySelector('[data-act="remove"]').click();
      return true;
    })()`);
    const removed = await waitFor(async () => ((await api("GET", "/email-accounts")).json?.accounts ?? []).length === 0);
    ok("Remove deletes the email account", Boolean(removed));

    // P9 assistant panel: opens from the launcher, offers 3 example
    // commands, and reports the local model's state (no model is needed
    // here — without Ollama the status line must say so, not hang).
    await page.evaluate(`document.querySelector('#agent-launcher').click(); true`);
    const panel = await waitFor(() =>
      page.evaluate(`(() => {
        const p = document.querySelector('#agent-panel');
        const s = document.querySelector('#agent-status').textContent;
        const ex = document.querySelectorAll('.agent-empty button').length;
        return !p.hidden && ex === 3 && !/checking/.test(s) ? s : undefined;
      })()`),
    );
    ok("assistant panel opens with 3 example commands and a model status", Boolean(panel), panel ?? "");

    ok("no uncaught exceptions in the console page", page.exceptions.length === 0, page.exceptions.slice(0, 3).join(" | "));
  } finally {
    page?.close();
    // Whole tree: Chromium's renderer/GPU/network children are separate
    // processes, and one left alive would also pin the temp profile dir.
    if (process.platform === "win32" && browser.pid) {
      await new Promise((r) => {
        const t = spawn("taskkill", ["/PID", String(browser.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
        t.once("exit", r);
        t.once("error", r);
      });
    } else {
      browser.kill();
    }
    await new Promise((r) => (browser.exitCode !== null || browser.signalCode !== null ? r() : browser.once("exit", r)));
    rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
