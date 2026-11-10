# Roadmap

## P1 — Engine distribution & launch identity (DONE v0.2.0, health/CLI v0.4.0)

- Checksummed, consent-gated engine installer (`EngineInstaller`): SHA-256
  pinned, atomic install, idempotent, mismatch = hard refusal. ✅
- Launch-identity snapshots: every run freezes its identity/proxy/engine;
  edit-while-running allowed; `GET /profiles/:id/drift` = "applies at next
  start". ✅
- Engine health probe: `GET /engine/health` (runtime, binary presence,
  verified install receipts) and `POST /engine/self-test` (throwaway
  launch + clean stop). ✅ v0.4.0
- CLI `queuepilot engine install --manifest <file> --yes` wrapping the
  installer; without `--yes` it prints the entry and refuses. ✅ v0.4.0
- Fingerprint attestation: `GET /profiles/:id/attest` probes a live page over
  CDP (throwaway about:blank target, flatten-attach, Runtime.evaluate) and
  compares what the engine ACTUALLY materialized against the launch snapshot —
  verdict match/mismatch/unattested, never a fabricated match. ✅ v0.9.0

## P1.5 — Jancy-parity core (DONE — providers v0.3.0, temp proxies v0.4.0, tabs v0.5.0/v0.6.0, sheets v0.7.0)

- Profile providers: CSV import with the full optional-column spec (groups,
  tab color, address, DOB, phone, SMS numbers incl. country codes, passcodes,
  free columns, per-profile proxy list, notes, URL, timezone, credit-card
  sets), refreshable upserts that never churn identity or run state. ✅
- Proxy providers: delimited files (comma/tab/colon/semicolon), optional
  header, timezone column, persist/start-over/random distribution via
  `POST /proxy-providers/:id/next`, refresh replaces the pool but refuses
  while any of its proxies are attached. ✅
- Temporary proxies: one-shot proxy per launch via
  `POST /profiles/:id/start` + `tempProxy`; never persisted, provenance
  recorded in the launch snapshot (`proxySource`), drift explains it while
  live, profile proxy applies again at next start. ✅ v0.4.0
- Tab/partition model: tabs live inside a run; every tab sits in an isolated
  in-memory session partition unless opened with `relatedTo` (shares the
  parent's partition — the related-tabs session model). Cross-run relations
  are refused, closes are idempotent, tab state dies with the run and is
  never persisted, and runtimes without tab support answer `501
TABS_UNSUPPORTED`. `tab.opened`/`tab.closed` on the SSE stream. ✅ v0.5.0
- Engine-side tab routing for camoufox: dependency-free CDP client
  (`Target.createBrowserContext` per partition, `Target.createTarget` /
  `Target.closeTarget` per tab), debugger URL discovered via `/json/version`,
  contexts disposed on stop. Engines without browser contexts get
  TABS_UNSUPPORTED — never a silently shared session. ✅ v0.6.0
- Google Sheets providers: loopback OAuth flow (readonly Sheets scope, tokens
  under the data dir), sheets feed the same row parsers as CSV/delimited
  files, refresh upserts identically. ✅ v0.7.0
- P1.5 COMPLETE. Next track: P2 web dashboard.

## P2 — Web dashboard (DONE v0.8.0)

- Console served by the API itself at `/`: profiles grid (start/stop,
  fingerprint regen, drift badge, tab counts), proxy manager with liveness
  tests, live lifecycle feed over the existing SSE stream. No separate
  hosting. ✅
- Deliberate substitution: zero-build vanilla JS instead of React. QueuePilot
  is local-first with no bundler; the dashboard ships as static assets in the
  repo, works offline on loopback, and honors the API bearer token. If the
  console outgrows it, a React app can replace `src/dashboard/` without
  touching the API. Audited in ADR-0005: vanilla holds through P3/P4; the
  console migrates to React 19 + Vite (`apps/web/`, built to static assets
  the API serves) at the start of the console-depth track.

## P3 — Automation depth

- Playwright/Puppeteer connection helpers: `@queuepilot/client` typed
  zero-dependency SDK; `connect()` starts a profile and returns
  `{ wsEndpoint, debugPort }` ready for `puppeteer.connect` /
  `chromium.connectOverCDP`; start also returns the endpoint for library
  mode. ✅ v0.9.0
- Script runner: `queuepilot script <file.mjs> --profile <id>` runs a user
  module against a profile — borrows the live session (starts if needed,
  never stops), typed client + CDP endpoint handed to the script. ✅ v0.9.0
- Warmup recorder. (open)

## P4 — Own engine track

- P4a spike (DONE v0.10.0): `fury` runtime launches Fury's prebuilt BSD
  Chromium core (checksummed, consent-gated install; persona JSON delivered
  via inherited HANDLE per the BSD patch contract). Validated live on
  Windows: install → launch → attestation `match` → isolated tabs → clean
  stop.
- P4b claim suite (DONE v0.11.0): `apps/api/verify/` — 10 static detection
  claims (webdriver, UA shape, UA-CH brands, `window.chrome` stock surface,
  automation traces, plugins, permissions, worker consistency, canvas
  determinism, WebGL coherence) plus persona-bound expectation claims
  (platform, cores, screen, timezone, locale), probed over CDP against a
  throwaway loopback page. Claims calibrated against stock Chrome ground
  truth (`npm run verify:calibrate`), not detector folklore — e.g. modern
  stock Chrome does NOT expose `chrome.runtime` to web pages. Live result:
  16/16 PASS on fury-core (Chrome 157). Run: `npm run verify --workspace
  apps/api -- --engine fury`. Remaining P4: external checker pass (CreepJS/
  sannysoft-class surfaces, deliberately manual) on every engine bump, then
  the default-engine decision.
- **P0 (found in P4 audit 2026-11-10): fury runtime silently drops
  `proxyUrl`** — a profile with a proxy browses on the real IP. Fix =
  auth-injecting loopback relay + refuse-loudly + `egress-via-proxy` claim.
  See docs/parity.md §2. NEXT TASK.
- P4c own build (OPEN, approved 2026-11-10): Fury's BSD patchset + build
  chain vendored into `engine/` (provenance, license and the engine-bump
  ritual in `engine/README.md`). First overnight build on the reference
  machine, then Fury's per-patch verify harness + our claim suite on OUR
  binary; only then publish our own tarball in the engine manifest.
  Hardware pre-flight done: 207GB free NVMe, 32GB RAM, 6c/12t (est. 6–12h).

## P5 — Team mode

- Optional self-hosted sync server: encrypted profile bundles, profile
  locking, role-based access. Local-first remains the default forever.

## P6 — Secrets hardening

- Proxy passwords and cookies move from SQLite to the OS keychain
  (DPAPI / Keychain / libsecret) behind a `SecretStore` port.

## Open decision items

- **D-002**: PID-reuse hardening — store per-platform process start tokens
  (Windows: process creation time; Linux: `/proc/<pid>/stat` starttime) so
  recovery can prove identity, not just liveness.
- **D-003**: Proxy rotation links (per-launch endpoint refresh) — design owed.
- **D-004**: RESOLVED (ADR-0006): dual engine — Fury's prebuilt BSD Chromium
  core as a second runtime (kind `fury`) via our checksummed installer,
  camoufox stays default until attestation + detection probes say otherwise.
  Spike plan in ADR-0006 (P4a). Claim-based detection suite done (P4b,
  v0.11.0); external checker pass (CreepJS/sannysoft) still owed, manual.
