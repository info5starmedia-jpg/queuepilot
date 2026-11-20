# Producing a QueuePilot build (R)

QueuePilot ships as **one minified program file** for the whole API + console,
not a loose source tree and not a separate console download. The build is
driven by [`scripts/build-release.mjs`](../scripts/build-release.mjs) (esbuild).

## Commands

Run from the repo root (a C: worktree — npm workspaces can't install on the
FAT32 `D:` copy):

```
npm run build:release          # internal / owner build (local warmups work)
npm run build:release:tester   # tester build (warmups require the team server)
```

Output goes to `dist-release/` (git-ignored):

```
dist-release/
  server/queuepilot.mjs          the entire API + routes + engine glue, bundled,
                                 minified and identifier-mangled into one file
  server/queuepilot.mjs.meta.json  esbuild bundle report (not shipped to testers)
  dashboard/                     the console, app.js minified (Kimi #7)
  package.json                   name/version + the two external deps only
  start-queuepilot.cmd           one-command launcher
```

## What is in the one file, and what stays external

Every first-party TypeScript module and every pure-JS dependency (fastify,
zod, pino, imapflow, mailparser, xlsx, …) is bundled and minified into
`server/queuepilot.mjs`. No readable first-party source ships.

Two modules cannot live inside a single JS file and stay external:

- **`better-sqlite3`** — a native `.node` addon.
- **`playwright-core`** — ships its own browser-driver plumbing.

The generated `dist-release/package.json` lists only those two. To run a
build on a tester's machine:

```
cd dist-release
npm ci --omit=dev      # pulls only better-sqlite3 + playwright-core
start-queuepilot.cmd   # or: node server/queuepilot.mjs
```

(`npm ci` here does not touch the repo; `dist-release` is self-contained.)

## Tester build: no local warmup planner, no personas

`--tester` removes the warmup planner and the bundled persona content, so a
tester build cannot plan or run warmups on its own — warmups then come from
the team server (Settings → Team). Concretely the build:

- replaces [`apps/api/src/application/warmups/persona/warmup/plan.ts`](../apps/api/src/application/warmups/persona/warmup/plan.ts)
  with a stub whose `compilePlan` throws
  `"warmups run on the team server in this build — set Settings -> Team"`, and
- strips the shipped site lists from the default persona (the schema needs at
  least one site, so one inert `https://example.com` placeholder remains).

Verified on a tester build: `POST /profiles/:id/warmup/persona` with no team
server configured returns `400 VALIDATION_FAILED` with that message, and the
planner algorithm (`zonedToEpoch`, the persona site URLs) is absent from the
bundle. The owner build keeps the planner and runs warmups locally.

## "Obfuscation"

The bundle is minified with full identifier mangling and no comments
(esbuild `minify` + `minifyIdentifiers`, `keepNames: false`). This is
minification-grade obfuscation — local names are destroyed and the code is a
single dense file. It is **not** control-flow obfuscation; if the owner wants
that, add a dedicated pass (e.g. `javascript-obfuscator`) as a post-step on
`server/queuepilot.mjs`. That is left out here to avoid a new runtime/build
dependency without the owner's say-so (**Owner question 8**).
