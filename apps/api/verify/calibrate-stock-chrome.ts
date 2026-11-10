import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { withPage } from "../src/application/runtime/cdp/cdp-page.js";

const chrome = process.argv[2] ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const port = 9377;
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "stock-chrome-diag-"));

const server = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end("<!doctype html><title>diag</title>");
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const pagePort = (server.address() as { port: number }).port;

const headless = process.argv.includes("--headless");
const proc = spawn(chrome, [
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${userDir}`,
  "--no-first-run",
  "--no-default-browser-check",
  ...(headless ? ["--headless=new"] : ["--window-position=32000,32000"]),
  "about:blank",
], { stdio: "ignore" });

let ws = "";
for (let i = 0; i < 30; i++) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`);
    if (res.ok) {
      ws = ((await res.json()) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl;
      break;
    }
  } catch { /* retry */ }
  await new Promise((r) => setTimeout(r, 500));
}
if (!ws) { console.log("DIAG: no debug port"); process.exit(2); }

await withPage(ws, `http://127.0.0.1:${pagePort}/`, async (page) => {
  const out = await page.evaluate(`JSON.stringify({
    typeofChrome: typeof window.chrome,
    chromeKeys: typeof window.chrome === 'object' && window.chrome ? Object.keys(window.chrome) : null,
    hasRuntime: !!(window.chrome && window.chrome.runtime),
    runtimeKeys: window.chrome && window.chrome.runtime ? Object.keys(window.chrome.runtime).slice(0, 10) : null,
    webdriver: navigator.webdriver,
    ua: navigator.userAgent,
  })`);
  console.log("DIAG:", out);
});
proc.kill("SIGKILL");
server.close();
try {
  fs.rmSync(userDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
} catch { /* chrome may hold locks briefly; temp dir is disposable */ }
