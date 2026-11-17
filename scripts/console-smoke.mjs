/**
 * Console smoke — drives the REAL dashboard in a headless Chromium and
 * clicks its buttons, the way a family member does.
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

export async function runConsoleSmoke({ base, ok }) {
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
      headers: body === undefined ? {} : { "content-type": "application/json" },
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

    ok("no uncaught exceptions in the console page", page.exceptions.length === 0, page.exceptions.slice(0, 3).join(" | "));
  } finally {
    page?.close();
    browser.kill();
    await new Promise((r) => (browser.exitCode !== null ? r() : browser.once("exit", r)));
    rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
