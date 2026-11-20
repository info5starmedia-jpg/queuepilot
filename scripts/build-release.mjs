// R — release packaging (owner ask + Kimi #7).
//
// Produces ONE minified + mangled program file for the whole API + console
// (no loose first-party source tree, no separate console download): every
// QueuePilot .ts/.js is bundled and minified into dist-release/server/
// queuepilot.cjs, and the dashboard is shipped minified alongside it. Only
// the two modules that cannot be inlined stay external: better-sqlite3 (a
// native .node addon) and playwright-core (ships its own browser plumbing).
//
//   node scripts/build-release.mjs            internal/owner build (local warmups work)
//   node scripts/build-release.mjs --tester   tester build: NO local warmup planner and
//                                              NO bundled personas — warmups then require
//                                              the team server (Settings -> Team).
//
// The result is self-contained apart from those two native deps, which the
// install step provides with `npm ci --omit=dev` in dist-release/.

import { build, transform } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tester = process.argv.includes("--tester");
const out = path.join(root, "dist-release");
const apiRoot = path.join(root, "apps", "api");

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, "server"), { recursive: true });

// Tester build: replace the local warmup planner with a stub that refuses, and
// blank the bundled persona's site lists, so the program carries neither.
const stripLocalWarmup = {
  name: "strip-local-warmup",
  setup(b) {
    b.onLoad({ filter: /warmup[\\/]plan\.ts$/ }, () => ({
      contents: `import { DomainError, ErrorCodes } from "@queuepilot/contracts";
        export function compilePlan() {
          throw new DomainError(ErrorCodes.VALIDATION_FAILED,
            "warmups run on the team server in this build — set Settings -> Team");
        }`,
      loader: "ts",
    }));
    b.onLoad({ filter: /warmup[\\/]persona\.ts$/ }, async (args) => {
      const src = await fs.promises.readFile(args.path, "utf8");
      // Drop the shipped site lists. The schema needs sites.min(1), so the
      // default persona keeps one inert placeholder and nothing real to warm on.
      return {
        contents: src
          .replace(/sites:\s*\[[\s\S]*?\n {2}\],/, 'sites: [{ url: "https://example.com" }],')
          .replace(/extraSites:\s*\[[\s\S]*?\n {2}\],/, "extraSites: [],"),
        loader: "ts",
      };
    });
  },
};

const result = await build({
  entryPoints: [path.join(apiRoot, "src", "main.ts")],
  outfile: path.join(out, "server", "queuepilot.mjs"),
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  minify: true,
  minifyIdentifiers: true,
  keepNames: false,
  legalComments: "none",
  // Native / browser-launching modules can't live inside one JS file.
  external: ["better-sqlite3", "playwright-core"],
  // ESM output + bundled CJS deps (fastify/avvio do a runtime require("node:events")):
  // give the bundle a real `require` so those dynamic requires resolve.
  banner: {
    js:
      "/* QueuePilot " + (tester ? "tester" : "internal") + " build — minified, do not edit */\n" +
      "import { createRequire as __qpCreateRequire } from 'node:module';\n" +
      "const require = __qpCreateRequire(import.meta.url);\n",
  },
  metafile: true,
  plugins: tester ? [stripLocalWarmup] : [],
});
fs.writeFileSync(path.join(out, "server", "queuepilot.mjs.meta.json"), JSON.stringify(result.metafile));

// Console: minify index.html's inline-free assets. app.js is minified with
// terser; index.html and styles.css are copied (already small, and the HTML
// references the asset by name). This is Kimi #7 (console JS ships minified).
const dash = path.join(apiRoot, "src", "dashboard");
const dashOut = path.join(out, "dashboard");
fs.mkdirSync(dashOut, { recursive: true });
for (const file of fs.readdirSync(dash)) {
  const from = path.join(dash, file);
  if (file.endsWith(".js")) {
    const min = await transform(fs.readFileSync(from, "utf8"), { loader: "js", minify: true, legalComments: "none" });
    fs.writeFileSync(path.join(dashOut, file), min.code);
  } else {
    fs.copyFileSync(from, path.join(dashOut, file));
  }
}

// The install manifest: only the two deps that stayed external, plus the
// native sqlite driver's own dep. `npm ci --omit=dev` in dist-release pulls
// just these — no first-party source is ever shipped.
const apiPkg = JSON.parse(fs.readFileSync(path.join(apiRoot, "package.json"), "utf8"));
const keep = ["better-sqlite3", "playwright-core"];
fs.writeFileSync(
  path.join(out, "package.json"),
  JSON.stringify(
    {
      name: "queuepilot-release",
      version: apiPkg.version,
      private: true,
      type: "module",
      bin: { queuepilot: "server/queuepilot.mjs" },
      scripts: { start: "node server/queuepilot.mjs" },
      dependencies: Object.fromEntries(keep.map((k) => [k, apiPkg.dependencies[k]])),
    },
    null,
    2,
  ),
);

// A thin launcher so a tester runs one command.
fs.writeFileSync(path.join(out, "start-queuepilot.cmd"), "@echo off\r\nnode \"%~dp0server\\queuepilot.mjs\" %*\r\n");

const bytes = fs.statSync(path.join(out, "server", "queuepilot.mjs")).size;
console.log(`[release] ${tester ? "TESTER" : "internal"} build -> ${path.relative(root, out)}`);
console.log(`[release] server/queuepilot.mjs  ${(bytes / 1024 / 1024).toFixed(2)} MB  (externals: ${keep.join(", ")})`);
console.log(`[release] local warmup planner: ${tester ? "EXCLUDED (team server required)" : "included"}`);
