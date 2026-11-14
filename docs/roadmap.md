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
- **P0 (found in P4 audit 2026-11-10, FIXED v0.12.0): the fury runtime used
  to silently drop `proxyUrl`.** Now every configured proxy is fronted by an
  auth-injecting loopback relay, unsupported schemes refuse loudly
  (PROXY_UNSUPPORTED), and the `egress-via-proxy` claim proves the chain
  live: `npm run verify --workspace apps/api -- --engine fury --proxy`.
- P4c own build (DONE v0.12.6, 2026-11-14): Fury's BSD patchset + build
  chain vendored into `engine/` (provenance, license and the engine-bump
  ritual in `engine/README.md`). First overnight build on the reference
  machine, then Fury's per-patch verify harness + our claim suite on OUR
  binary; only then publish our own tarball in the engine manifest.
  Hardware pre-flight done: 207GB free NVMe, 32GB RAM, 6c/12t (est. 6–12h).
  **Shipped: official LTO+PGO build (58,720/58,720 steps), Fury harness
  43/43 green, claim suite 25/25 + 22/22 proxy, manifest `0.5.5-qp.3`,
  parity audit all 6 gates green (docs/handoff.md "Final gate").**
- Fury 0.5.5 parity (DONE 2026-11-14): patches 0052 (Local Font Access
  filter), 0071 (WebRTC synthetic candidates — agent does a fresh per-launch
  exit-IP check through the relay and writes `webrtc.publicIp`/`hostName`),
  0123 (built-in AI answers "downloadable" like Chrome, never downloads).
  Persona now declares the desktop-mains battery tuple (0121 passes the
  host's real battery through when unconfigured — the host UPS at 0.98 was
  the audit's one red claim). AliasMode discipline adopted: delete waits out
  in-flight start/stop (`ensureIdle`), launch refusals name their stage
  (`process_spawn:`/`engine_start:`), engine fetcher resumes stalled
  downloads with Range retries.

## P5 — Team mode

- Optional self-hosted sync server: encrypted profile bundles, profile
  locking, role-based access. Local-first remains the default forever.
- Foundation 🟡 v0.12.6: the bundle format the sync server will move between
  machines exists and is encrypted (`bundles/session-bundle.ts`); profile
  locking across processes already lives at the storage layer (admission
  slots + the per-profile partial unique index). Still open: the server
  itself, roles, multi-user leases.

## P6 — Secrets hardening

- Proxy passwords and cookies move from SQLite to the OS keychain
  (DPAPI / Keychain / libsecret) behind a `SecretStore` port. ✅ v0.12.5 —
  `secrets/secret-store.ts`: DPAPI (CurrentUser) on Windows via ProtectedData,
  plaintext dev fallback only behind explicit QUEUEPILOT_SECRET_STORE=plaintext.
  ProxyService + ProxyProviderService route passwords through the port;
  pre-v0.12.5 rows migrate lazily on first read (plaintext dies without
  operator action). Cookies remain engine-side (os-crypt, parity 0110).

## GATE — Jancy feature-parity audit (REQUIRED before this build is called done)

The mission formula is Fury engine + AliasMode lifecycle + **Jancy workflow**.
Fury/AliasMode parity is proven (0.5.5-parity audit, all gates green 2026-11-14);
the Jancy leg is NOT yet audited row-by-row. Before the build ships to
family/friends, run a feature-parity audit of Jancy's documented surface
against QueuePilot: profiles via CSV/Sheets, proxy providers, resolvers, tab
operations, plugins/extensions, scripting (client SDK + script runner),
fingerprint checkers, batch operations. Output: docs/parity-jancy.md with one
row per Jancy feature — have / missing / deliberately-different (with reason).
Any "missing" row becomes a P7 item. Source material: the Jancy research in
the repo (Kimi_Agent_Jancy Clone Repo Search.zip) + public Jancy docs.

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

## P7 — Post-engine batch (parity audit PASSED 2026-11-14 — this batch is now unblocked)

Ordered by dependency, not size. Every item ships with its claim/verify proof
— no green checkbox without a live check, same rule as everything above.

1. **os-crypt wiring (parity 0110)** — cookies move off engine-side plaintext
   onto the SecretStore port (DPAPI first). Acceptance: `verify-0110` green on
   our own binary, parity row flips to done.
2. **socks5 in proxy-relay** — currently refuses loudly (PROXY_UNSUPPORTED);
   implement the upstream-chain path so the refusal never fires. Acceptance:
   `egress-via-proxy` claim passes with a socks5 upstream.
3. **Egress diagnostics API** — surface the proxy chain, DNS and WebRTC leak
   state per running profile in the console. Acceptance: diagnostics endpoint
   + claim proving the values match an external probe.
4. **External checker pass (D-004 remainder)** — CreepJS / sannysoft against
   our own binary, results recorded in docs/parity.md. Manual, one sitting.
5. **Extensions registry** — per-profile extension install/list/remove.
6. **TOTP field for personas** — completes the speech-persona gap too.
7. **Team server (P5 remainder)** — self-hosted sync, roles, multi-user
   leases, on top of the v0.12.6 encrypted bundle format.
8. **D-002 / D-003** — PID-reuse hardening (start tokens), proxy rotation
   links design.
9. **React console (ADR-0005)** — optional; vanilla console is shippable.

## Done since P7 was queued (2026-11-13/14, v0.12.6)

- **P6.1 CSV import** — `POST /profiles/import` (dry-run + upsert, bad row
  never aborts the file) + console UI (file/paste → preview → apply).
- **P6.3 session bundles v2** — manifest carries group/tags/notes/tabUrls/
  sanitized proxy reference (passwords stay DPAPI machine-bound);
  `POST /bundles/restore` creates/upserts the profile, optionally starts it,
  imports cookies, reopens tabs. Roaming without password travel.
- **P6.4 CLI** — `queuepilot` command surface (profiles/bundles/engine).
- **P5.5 installer** — `scripts/package-installer.ps1` packs the built engine
  into a shareable zip; `setup.ps1` verifies SHA-256, installs under
  `%LOCALAPPDATA%\QueuePilot\engines\`, writes the install receipt, prints
  the AV note. `docs/av-notes.md` documents Norton/Defender/Avast exclusions
  (self-built unsigned engine is expected to be flagged). Console gained a
  first-run Setup checklist.

## P7 additions from the Fury 0.5.5 / AliasMode update scan (2026-11-14)

- **Bookmark sets** (Fury 0.5.3): named folders of links deployed to many
  profiles at launch, written at the front of the bookmarks bar with the
  set's id in meta_info; browser-made bookmarks never touched.
- **Extensions registry v2** (Fury 0.5.4): install from .crx/.zip/unpacked
  folder, pinned extension ids (generated RSA key per extension name kept
  machine-side so ids and storage survive versions and profiles); copy from
  another profile deliberately WITHOUT storage (shared storage = two
  personas tied together).
- **Start pages on every launch** (Fury 0.5.2): pass the profile's start
  URLs at every start, not just the first.
- Skipped deliberately: Fury's commercial store/partner UI and their
  account-recovery server (not our family/friends mission).

## P5.6 — Perf & startup (open)

- Cold-start measurement (launch → first page) on the official build;
  budget < 2.5 s on this machine.
- Profile dir hygiene: confirm no `DevToolsActivePort` staleness, no
  leftover Singleton* locks after hard kills.
