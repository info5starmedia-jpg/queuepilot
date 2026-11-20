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
import JsObfuscator from "javascript-obfuscator";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tester = process.argv.includes("--tester");
// Strong obfuscation (owner, 2026-11-20): a javascript-obfuscator pass on top
// of esbuild's minify+mangle. On by default; --no-obfuscate skips it for a
// debuggable build. The server bundle is ESM + large (fastify, etc.), so the
// transforms that most often break or bloat a big bundle — controlFlow
// flattening and dead-code injection — are left OFF there; the console is
// small and browser-only, so it takes the heavier pass.
const obfuscate = !process.argv.includes("--no-obfuscate");

/** Shared, correctness-safe obfuscator options. */
const baseObf = {
  compact: true,
  identifierNamesGenerator: "hexadecimal",
  numbersToExpressions: true,
  simplify: true,
  splitStrings: true,
  splitStringsChunkLength: 8,
  stringArray: true,
  stringArrayEncoding: ["base64"],
  stringArrayThreshold: 0.8,
  transformObjectKeys: true,
  selfDefending: true,
  // The reserved names below MUST survive: Node globals and the external
  // module ids esbuild emits as top-level imports/requires.
  reservedStrings: ["better-sqlite3", "playwright-core", "node:.*"],
};
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

// Strong pass over the server bundle. ESM: keep the module syntax, and leave
// controlFlowFlattening / deadCodeInjection off (they break or bloat a bundle
// this size). esbuild has already minified+mangled; this adds a string array
// (base64), object-key transforms, self-defending and number expressions.
const serverFile = path.join(out, "server", "queuepilot.mjs");
if (obfuscate) {
  const src = fs.readFileSync(serverFile, "utf8");
  const res = JsObfuscator.obfuscate(src, {
    ...baseObf,
    target: "node",
    controlFlowFlattening: false,
    deadCodeInjection: false,
    // The require shim in the banner uses import.meta — don't let the pass
    // rename module-level bindings it needs.
    renameGlobals: false,
  });
  fs.writeFileSync(serverFile, res.getObfuscatedCode());
}
// Fail loudly if the pass produced code Node can't even parse.
execFileSync(process.execPath, ["--check", serverFile], { stdio: "pipe" });

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
    // The console is small and browser-only, so it takes the full pass,
    // control-flow flattening included.
    const code = obfuscate
      ? JsObfuscator.obfuscate(min.code, {
          ...baseObf,
          target: "browser",
          controlFlowFlattening: true,
          controlFlowFlatteningThreshold: 0.5,
          deadCodeInjection: true,
          deadCodeInjectionThreshold: 0.2,
          disableConsoleOutput: false,
        }).getObfuscatedCode()
      : min.code;
    fs.writeFileSync(path.join(dashOut, file), code);
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
console.log(`[release] obfuscation: ${obfuscate ? "ON (esbuild mangle + javascript-obfuscator)" : "off (--no-obfuscate)"}`);
console.log(`[release] local warmup planner: ${tester ? "EXCLUDED (team server required)" : "included"}`);
