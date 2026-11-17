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
- Warmup recorder + player. ✅ v0.16.0 (`97dad9f`) — record a live profile's
  URL visit sequence with real dwell times (`POST /profiles/:id/warmup/record`,
  poll-based so it works on every runtime), replay on any profile for cookie
  warming (`POST /warmups/:id/run`, dwell re-sampled ±20%, per-step error
  isolation, starts idle profiles, `stopAfter` opt-in). Recipes are plain
  operator-owned JSON under `<dataDir>/warmups/`.

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
  apps/api -- --engine fury`. External checker pass (CreepJS/sannysoft-class
  surfaces, visual review deliberately manual): harness ✅ v0.16.0
  (`scripts/detection-check.mjs` — launches a profile, opens CreepJS +
  sannysoft staggered, snapshots the attestation verdict + engine/proxy
  identity beside them, writes a `docs/reports/detection-check-*.md` report
  the operator signs off). One manual run per engine bump remains — it needs
  eyes on the checker pages, on a fury-core machine.
  **External checker pass: DONE 2026-11-16** — live run on the operator's
  desktop (desktop takeover, results read over CDP): sannysoft 26/26 green,
  CreepJS 0% headless / 0% stealth / no lies, AliasMode TLS 0 problems,
  AliasMode fingerprint 0 problems / 23 passed
  (`docs/reports/detection-check-2026-11-16.md`).
  **Default-engine decision: MADE 2026-11-16 — fury is the default runtime.**
  It passed every attestation + detection probe; camoufox stays selectable
  via `SPECTRA_RUNTIME=camoufox` for A/B fallback.
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
- **COMPLETE v0.16.0** — the 2026-11-14 P7.7 track delivered the whole
  surface and this batch closed the last ops gap:
  - Server (`apps/server`): durable mailbox for SEALED bundles — payloads are
    opaque bytes end to end, no decrypt path on the box. SHA-256-hashed
    tokens with three roles (viewer reads / operator reads+writes / admin
    also mints+revokes tokens), plaintext shown once at mint.
  - Optimistic concurrency: bundle pushes carry `baseRevision`, stale pushes
    get 409 REVISION_CONFLICT with the current revision — two machines can
    never silently overwrite one profile.
  - Multi-user launch leases (P7.7b): `hostname:pid` holders, TTL + renew
    while running, expired-lease takeover (crashed-holder cleanup), stranger
    release is a no-op, `TEAM_LEASE_HELD` reaches the second machine's start
    call. Admin **force-release** (`DELETE /leases/:profileId`, v0.16.0) evicts
    a stuck lease without waiting out the TTL.
  - Client side (`team-client.ts`, `team-sync.ts`, `team-sync-loop.ts`,
    `team-lease-guard.ts`): bearer auth, pull+rebase+retry on conflict,
    background sync loop, lease guard wired into profile start.
  - 20 server tests green (roles, leases, concurrency, hash-only tokens).

## P6 — Secrets hardening

- Proxy passwords and cookies move from SQLite to the OS keychain
  (DPAPI / Keychain / libsecret) behind a `SecretStore` port. ✅ v0.12.5 —
  `secrets/secret-store.ts`: DPAPI (CurrentUser) on Windows via ProtectedData,
  plaintext dev fallback only behind explicit QUEUEPILOT_SECRET_STORE=plaintext.
  ProxyService + ProxyProviderService route passwords through the port;
  pre-v0.12.5 rows migrate lazily on first read (plaintext dies without
  operator action). Cookies remain engine-side (os-crypt, parity 0110).

## GATE — Jancy feature-parity audit ✅ PASSED 2026-11-16

The mission formula is Fury engine + AliasMode lifecycle + **Jancy workflow**.
Fury/AliasMode parity is proven (0.5.5-parity audit, all gates green 2026-11-14);
the Jancy leg is audited row-by-row in `docs/parity-jancy.md`, final sign-off
2026-11-16 with the remaining rows classified as owner-approved
deferrals or plugin-shaped content (D-003 rotation links shipped same day,
`6a1ede3`). The build may ship to family/friends on the
workflow surface; the external checker pass (CreepJS/sannysoft, P4) is the last
verification owed before calling the ENGINE done.

## Open decision items

- **D-002**: PID-reuse hardening — store per-platform process start tokens
  (Windows: process creation time; Linux: `/proc/<pid>/stat` starttime) so
  recovery can prove identity, not just liveness.
- **D-003**: RESOLVED 2026-11-16 (`6a1ede3`): proxy rotation links shipped —
  per-launch pool resolution, `proxySource: "rotation"` snapshots, loud
  refusal when no resolver is wired. See v0.16 item 7.
- **D-004**: RESOLVED (ADR-0006): dual engine — Fury's prebuilt BSD Chromium
  core as a second runtime (kind `fury`) via our checksummed installer.
  Spike plan in ADR-0006 (P4a). Claim-based detection suite done (P4b,
  v0.11.0); external checker pass DONE 2026-11-16 (detection-check report
  above). **fury is the default runtime as of 2026-11-16**; camoufox remains
  selectable for A/B fallback. Remaining detection polish (warnings, not
  failures): deviceMemory↔heap coherence FIXED same day via the host-memory
  clamp in identity generation (`hostMemoryGb()`); canvas-noise cross-context
  presentation was the one open engine-side item — closed in fury-core
  0.5.5-qp.4 (`3c89fc9`, v0.16 item 8c), re-verified 2026-11-17 (Phase 2
  hardening below).

## P7 — Post-engine batch (parity audit PASSED 2026-11-14 — this batch is now unblocked)

Standing rule for EVERY item below: no item is done until all four sub-steps
are green — (a) code, (b) tests proving the behavior, (c) docs updated
(roadmap + parity row), (d) live verify on our own binary where the item
touches the engine. No green checkbox without a live check.

### 1. os-crypt wiring (parity 0110) — ✅ DONE 2026-11-14 (no rebuild needed)
Goal: cookies encrypt at rest under a per-profile key; a moved profile still
opens its jar. Result: the patch was ALREADY built into our binary (series
line 429) — the gap was runtime wiring only, so the predicted overnight
rebuild turned out to be unnecessary.
- a. ✅ Patch present in `engine/patches/0110-os-crypt-key.patch` + series.
- b. ✅ Runtime wiring: `runtime/oscrypt-key.ts` mints a per-profile 32-byte
    key at `<profileDataDir>/.queuepilot/oscrypt.key` (0o600; wrong-size files
    are set aside, never overwritten); the PowerShell bootstrap hands it over
    as an inherited HANDLE via `--fury-oscrypt-file-handle` alongside the
    persona config handle. Key lives in the profile dir (not DPAPI) so it
    travels with the profile per Fury's 0110 design; the trade-off is
    documented in parity.md.
- c. ✅ `engine/verify/verify-0110.py` on OUR binary: **7/7 claims PASS** —
    ciphertext on disk, same key reads back, wrong key degrades to an empty
    jar, control proves the key (not the file) does the work.
- d. ✅ Parity row flipped; unit tests for key management (3 tests).

### 2. socks5 in proxy-relay — ✅ DONE 2026-11-14
Goal: `PROXY_UNSUPPORTED` never fires for socks5 upstreams.
Sub-steps:
- a. ✅ socks5/socks5h accepted by `parseUpstream` (default port 1080,
    protocol-specific auth: RFC 1929 user/pass for socks5, Basic only for
    http/https). Relay speaks RFC 1928 CONNECT (IPv4/domain/IPv6 ATYP,
    remote resolution = socks5h semantics) with RFC 1929 subnegotiation;
    session-reader handshake (single buffered reader — unshift-then-reattach
    hangs on modern Node), leftover bytes pushed back before piping.
    Fail-closed throughout: refused creds/CONNECT → 502 to the engine, never
    a direct detour; refusals counted separately from network errors.
    Plain-HTTP requests work too (origin-form rewrite, no header injection).
- b. ✅ 4 new fixture tests against a fake socks5 server: CONNECT tunnel with
    creds, wrong-creds fail-closed (upstream dial count stays 0), plain-HTTP
    forwarding, hostname remote-resolution (ATYP 0x03). 13/13 relay tests.
- c. ✅ New `--socks5` verify mode with a recording RFC 1929 upstream.
    LIVE 2026-11-14: 23/27 claims hold on fury, `egress-via-socks5` PASS
    (12 proxied connections, credentials injected), `diagnostics-egress`
    PASS through the socks5 relay (exit IP == live probe).
Goal check: claim passes live — YES.

### 3. Egress diagnostics API — ✅ DONE 2026-11-14
Goal: operator sees proxy chain, DNS and WebRTC leak state per running
profile, matching what an external probe sees.
- a. ✅ `EgressInfo` on BrowserSession, captured by the fury runtime at
    launch (relay port, exit-IP check result, WebRTC keys); snapshot schema
    gained an `egress` block; launch measurements served verbatim — never a
    live re-check (would race rotating proxies).
- b. ✅ `GET /profiles/:id/egress` — running state, credential-redacted
    proxyUrl, proxySource, egress block.
- c. ✅ Claim `diagnostics-egress` in the verify suite (proxy mode): launch
    exit IP must match an independent probe through the same relay.
    LIVE 2026-11-14: 23/27 claims hold on fury, diagnostics-egress PASS
    (exit 99.234.58.124 == live probe through relay).

### 4. External checker pass (D-004 remainder)
Goal: third-party validation, not just our own claims.
Sub-steps:
- a. ✅ CreepJS + sannysoft against OUR binary as the product launches it
    (`npx tsx verify/external-check.ts --engine fury`).
    LIVE 2026-11-14: sannysoft 31/31 verdict rows green (all WebDriver rows
    "missing/passed", PHANTOM_* all ok); CreepJS headless 0%, stealth 0%.
    Self facts: navigator.webdriver=false. Two real fixes shipped by this
    check (see commit):
    1. `-EncodedCommand` bootstrap got the engine TerminateProcess'd ~10s
       after launch by endpoint AV; bootstrap now runs from a temp .ps1
       via -File (bisected: identical script, only the invocation differs).
    2. persona screen/avail incoherence: personaConfig now declares
       screen.availWidth/availHeight (patch 0020 reads them; before, the
       host workarea leaked → avail > screen → PHANTOM_WINDOW_HEIGHT red),
       identities are clamped to the host display, and window fit targets
       the claimed workarea, not the raw screen.
- b. ✅ Scores recorded in docs/parity.md §External checkers.
- c. ✅ Nothing red remained to fix or accept; exit 0.
Goal check: results table committed. Manual, one sitting.

### 5. Extensions registry (+ Fury 0.5.4 v2 semantics)
Goal: per-profile extension install/list/remove, ids stable across versions
and profiles.
Sub-steps:
- a. Install from .crx/.zip/unpacked folder; store under the profile dir.
- b. Pinned extension ids: generated RSA key per extension name, kept
    machine-side (SecretStore).
- c. Copy-from-profile WITHOUT storage (shared storage ties personas
    together — deliberate).
- d. Tests for install/list/remove + id stability; docs row.
Goal check: live install + Fury parity row done.

### 6. TOTP field for personas
Goal: persona model carries TOTP seed; completes the speech-persona gap.
Sub-steps:
- a. Schema: persona TOTP field (stored via SecretStore, never SQLite
    plaintext).
- b. Generator: current code via API (used by resolvers/macros).
- c. Tests + import-column support in CSV/Sheets providers.
Goal check: `POST /profiles/:id/totp` returns a valid rotating code.

### 7. Team server (P5 remainder) — NEXT WEEK, not this week
Goal: self-hosted sync between family/friends machines: encrypted bundles,
roles, multi-user leases. Foundation (encrypted bundle format, storage-level
locking) already shipped v0.12.6.
Sub-steps:
- a. ✅ Server package (`apps/server`, 2026-11-15, v0.14.11) — bundle
    push/pull + auth tokens:
    - `buildTeamServerApp` (fastify): `GET /health` (open), `GET/PUT/DELETE
      /bundles/:profileId` (raw sealed bytes, octet-stream), `GET /bundles`
      (heads with revision/size), `GET/POST/DELETE /tokens` (admin only).
    - Bearer auth, SHA-256 hash-only token storage (plaintext shown once at
      mint); `QUEUEPILOT_TEAM_ADMIN_TOKEN` bootstrap admin (env compared
      constant-time, never written to DB). Coarse roles enforced: viewer
      reads, operator reads+writes bundles, admin manages tokens.
    - Optimistic concurrency: `PUT ?baseRevision=N` → 409 REVISION_CONFLICT
      with the server's current revision; first push with a non-zero base is
      rejected (no create-under-race).
    - Client side: `TeamServerClient` (fetch, dependency-light) +
      `TeamSyncService` bridging the existing BundleService — push =
      exportBundle (profile must be running) → sealed bytes; pull =
      restoreBundle (upserts by manifest name, starts on demand, never
      invents machine-bound proxy credentials). New contract codes
      TEAM_UNAUTHORIZED/TEAM_NOT_FOUND/TEAM_UNAVAILABLE/
      TEAM_REVISION_CONFLICT mapped in the error mapper (401/404/503/409).
    - Tests: 10 server (auth, roles, round-trip, conflict, validation) + 6
      two-machine e2e (two API contexts against one live server: push/pull,
      re-pull upsert, stale-revision conflict, wrong passphrase, bad token,
      minted operator token). 443/443 green.
- b. ✅ per-profile leases — the double-start guard ACROSS machines
    (2026-11-15, v0.14.18; see roadmap item 22).
- c. ✅ Client sync loop + conflict policy (machine-bound secrets never
    sync) — TeamSyncLoop, pull-dominant v1 (2026-11-15, v0.14.18; item 22).
- d. Multi-machine test ✅ shipped in a (two API instances, one server).
Goal check (partial, a+d): profile created on machine A appears on machine B
with the session intact and a stale push is refused — YES (e2e). Lease
preventing double-start: still open (b).

### 8. D-002 / D-003 hardening — ✅ DONE 2026-11-14
Goal: recovery proves process identity, not just liveness; rotation links
designed.
Sub-steps:
- a. ✅ D-002: `browser_runs.process_token` (migration 004) + contract
    field; captured at launch via `captureProcessStartToken()` (Windows
    creation time via Get-Process, POSIX /proc starttime+btime; whole-second
    normalized); `isProcessAlive(pid, token)` treats same-PID+different-token
    as dead; boot reconciliation passes the stored token. Soft-failure rule:
    unreadable start time → fall back to plain liveness, never a guessed
    death. 7 tests incl. real-process PID-reuse simulation (live sleeper PID
    vs wrong token → dead).
- b. ✅ D-003: ADR-0007 merged — rotation links resolve into the existing
    tempProxy launch path (per-launch fetch, never persisted, fail closed,
    no mid-run rotation, fresh egress measurement per launch); schema change
    (rotation_url column) deferred to implementation.
Goal check: D-002 test green (7/7); D-003 ADR merged — YES.

### 9. Fury 0.5.5 additions scan (from their 2026-11-14 update) — ✅ DONE 2026-11-14
- **Bookmark sets** — ✅ implemented at the runtime layer (our engine's
  config schema has no bookmark key; a C++ rebuild for a file-format feature
  would be waste): `profile.extra.bookmarkSets` is merged into Chromium's
  own `Default/Bookmarks` before launch — folders at the bar front,
  `meta_info.qp_set_id` marker, re-launch replaces managed folders (a
  removed set disappears), browser-made bookmarks never touched, checksum
  dropped (Chromium regenerates), atomic write. Validation: named errors for
  bad URLs / duplicate ids / non-http schemes. 6 unit tests.
- **Start pages on every launch** — ✅ `startUrlsOf()` reads
  `profile.extra.startUrls[]` (array) or the Jancy `url` column (single) at
  EVERY launch and puts them in argv in place of about:blank; non-URL and
  non-http(s) entries never reach argv. 4 unit tests.
- **Live**: verify suite sets both on the probe profile; new claims
  `start-pages-launched` and `bookmark-sets` PASS — 27/27 standard,
  24/29+4sk proxy, 24/29+4sk socks5. In proxy modes the start page itself
  transits the recording upstream.
- Skipped deliberately: commercial store/partner UI, account-recovery
  server (not our mission).

### 10. JYL remainder — ✅ DONE 2026-11-14
Goal: Jancy's five capabilities all adopted.
Sub-steps:
- a. ✅ JYL web endpoints: `.mjs` modules export
    `endpoints: [{name?, path, method?, handler}]`, served at
    `/jyl/endpoint/<module>.mjs/<path>` behind the API token via one
    wildcard route the registry dispatches (rescans never re-register
    Fastify routes). Validation at scan: clean relative paths (no
    dot-segments), GET/POST/PUT/DELETE only, per-module method+path
    duplicates rejected. Handlers see {method, path, query, body, log,
    store, fetch}, 30s timeout, errors → 500 with the message.
- b. ✅ Settings bundles: `GET /settings/export` / `POST /settings/import`
    — secrets-free JSON (version 1). Alias NAMES only (values stay in the
    SecretStore; names now enumerable via a non-secret `alias.__names__`
    index key), plugin enable toggles, provider configs (sources/sheets/
    delimiter/distribution). Import is upsert-by-name, never destructive;
    unreadable sources are reported per-item, not fatal; malformed bundles
    → 400.
- c. ✅ 13 new tests (4 unit dispatch/validation, 3 HTTP endpoint, 3 HTTP
    settings round-trip incl. secret-absence assertion, re-import no-op,
    failed-provider reporting, 400). 272/272 tests, typecheck + build clean.
Goal check: §6 JYL row fully green — YES.

### 11. React console (ADR-0005) — optional, only if console outgrows vanilla
Goal: migrate `src/dashboard/` to React 19 + Vite (`apps/web/`) without
touching the API. Trigger condition: console-depth track (tabs mass-select,
Tab Thinger, Cookie Thinger) hits vanilla maintainability limits. Sub-steps
then: scaffold → port panels → same e2e checks → delete vanilla.

### 12. P5.6 Perf & startup — ✅ DONE 2026-11-14
Goal: cold start < 2.5 s on this machine; no profile-dir staleness after
hard kills.
Sub-steps:
- a. ✅ `apps/api/verify/coldstart.ts` measures launch → first page fetch
    through the REAL engine path (probe page as start URL). LIVE on
    fury-core (Windows, this machine): **1417 ms** — under the 2500 ms
    budget. Claim `cold-start` recorded.
- b. ✅ Hygiene audit via hard SIGKILL: this engine build leaves ZERO
    singleton residue (no DevToolsActivePort / Singleton* files — the
    launcher-clean relaunch succeeded in 895 ms). Defense-in-depth shipped
    anyway: `cleanProfileDirStaleness()` runs pre-spawn (only after the
    per-profile guard proves no live engine), removing DevToolsActivePort /
    SingletonLock / SingletonSocket / SingletonCookie / .org.chromium.*
    while leaving profile data untouched. 2 unit tests + live claim
    `hygiene-relaunch-after-hard-kill` PASS (2/2).
Goal check: numbers committed — YES.

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

Moved into the P7 numbered list above (items 5 and 9) so every task carries
its sub-steps and goal in one place.

## P7 Jancy-gap items (from parity-jancy.md)

1. ✅ **Plugin registry architecture** (2026-11-14, efa1e8d) — ESM plugin
   folders in `<dataDir>/plugins`, lifecycle hooks, namespaced resolver/parser
   contributions, persisted enable toggle, per-plugin failure isolation.
   API routes `/plugins`, `/plugins/rescan`, `/plugins/:id/enable`.
2. ✅ **Resolver + parser registries + token aliases** (2026-11-14, efa1e8d) —
   `ResolverRegistry` (static/env/webhook builtins, named `#...` errors,
   verbatim args), Site-column specs in `profile.extra.sites` (wildcard +
   most-specific), `@alias` tokens via DPAPI SecretStore, user `.mjs` parser
   modules from `<dataDir>/parsers`. 224/224 tests green.
3. ✅ **Provider resolvers** (2026-11-14, b9ee820) — gmail resolver on
   multi-account PKCE OAuth (per-account DPAPI tokens, auto-refresh);
   imap resolver covers the app-password path (f890417). sms-gateway
   variants ride the generic webhook; textchest-style providers = plugin
   content.
4. ✅ **JYL capability adoption** (2026-11-14, 74d46e6 + 8444c07) — user commands +
   macros as `.mjs` modules with ctx {args, profileId, log, store, fetch};
   `/jyl/run` API; JYL web endpoints + settings bundles in P7.10.
5. ✅ **Persona fields — the Jancy 2FA layer** (2026-11-14, v0.14) — typed
   read/validate layer over the provider-imported persona columns:
   - Contracts: `PersonaFieldsSchema` / `PersonaAddressSchema` /
     `PersonaSmsNumberSchema` / `UpdatePersonaInputSchema` (incl. well-known
     `fields`) + `PERSONA_WELL_KNOWN_FIELDS` in `@queuepilot/contracts`.
   - `PATCH /profiles/:id/persona` — validated partial merge into
     `profile.extra`; unknown bag keys ride through untouched.
   - `POST /profiles/:id/sms/rotate` — Jancy SMS cycling; persists
     `extra.smsIndex`, wraps modulo; 409 when no numbers (never a silent no-op).
   - `POST /profiles/:id/resolve` — `site` now optional; falls through Site
     columns to well-known fields (`extra.fields`): literals pass through
     (`pass:word` stays literal — only REGISTERED resolver prefixes resolve),
     specs resolve with profile email/site/field context.
   - 322/322 tests green; parity-jancy §1/§2 and parity.md §3 updated.
6. ✅ **Credit-card typed layer** (2026-11-14, v0.14) — shared
   `PersonaCreditCardSchema` in contracts (the import contract reuses it, one
   source of truth), `creditCards` joins the persona merge, and
   `GET /profiles/:id/cards` is masked-only: last4 + hasCvv + metadata — PAN
   and CVV are write-only and never echoed by any read route. Autofill
   wiring into CDP fill actions remains. 331/331 tests green.
7. ✅ **Per-profile proxy lists** (2026-11-14, v0.14) — Jancy's proxies
   column end to end:
   - `profile-proxies.ts` parse layer: `host:port[:user[:pass]]` (password
     keeps ':' verbatim), optional `http://`/`socks5://` prefix, unknown
     schemes refused not guessed, `system connection` magic value
     case-insensitive; unparseable entries dropped, order preserved.
   - `proxies` joins the persona merge; `extra.proxyIndex` (persisted) selects
     the current entry modulo length — same discipline as SMS cycling.
   - `GET /profiles/:id/proxies` masked (password never echoed, not even in
     the raw string — the first cut leaked it via `raw` and the test caught
     it); `POST …/proxies/rotate` advances with wraparound, 409 on empty.
   - Launches: no temp proxy + no attached proxy → current list entry feeds
     the engine (system → direct), snapshot `proxySource: "profile-list"`,
     drift explains it. Precedence: temp > attached > list > none.
   - 354/354 tests green. Remaining: per-launch auto-rotation (index advances
     on every start) — operator decision, current model is explicit rotate.
8. ✅ **Credit-card autofill** (2026-11-14, v0.14) — `POST
   /profiles/:id/autofill/card` pushes a named card set into the checkout
   page over CDP:
   - One `Runtime.evaluate` per fill: hint-based field detection
     (name/id/placeholder/aria-label/autocomplete), native input value
     setter + bubbling input/change events (React/Vue controlled inputs
     wake up), expiry MM/YY ↔ MM/YYYY adapted to the field's maxLength.
   - Values travel INTO the page only — the response names filled fields,
     never values; `NO_FILL_TARGET` added (409) when no page is open.
   - Tests: MockCdpServer grew attach/detach/getTargets/Runtime.evaluate
     hooks; FakeBrowserRuntime got a `nextWsEndpoint` override. 366/366
     green. Remaining: address/identity autofill (item 10), WPM typing
     simulation.
9. ✅ **Upstream rescan + adoption** (2026-11-14 evening) — Fury 0.5.2–0.5.5
   and AliasMode commits since the morning scan, full verdicts in
   `docs/upstream-scan-2026-11-14.md`:
   - Bookmark sets: machine-side known-id record — unknown markers
     (colleague's bundle sets) survive, emptied config cleans managed
     folders (Fury `70d26114`).
   - Extensions: one-folder-down manifest lifting + `__MACOSX` drop in zips
     and folder copies (Fury `98f5167d` / issue 28).
   - Launch refusals: `cdp_readiness` stage — bootstrap PID ≠ answering
     DevTools endpoint; named, cleaned up, unit-tested (AliasMode PR #219
     taxonomy completed).
   - Verified already-had: fresh egress check per proxied launch feeding
     WebRTC config; provider refresh never races a launch.
   - Queued: engine C++ patches 0052/0123/0071 for the next rebuild (P8);
     team-server recovery-key design recorded for P7.7.
10. ✅ **Address/identity autofill** (2026-11-14, v0.14.5) — `POST
    /profiles/:id/autofill/address` pushes the profile's name/email plus the
    persona's phone/DOB/address into the page over CDP:
    - One `Runtime.evaluate` per fill: hint-based detection
      (name/id/placeholder/aria-label/autocomplete) for first/last name,
      email, phone, DOB, address 1/2, city, zip — AND `<select>` elements
      for state/province/region (option matched by value or text,
      case-insensitive, abbreviation or full name, min length 2).
      Same native-setter + bubbling input/change discipline as card fill.
    - Identity assembly: profile name splits at the first space into
      first/last; email comes from the profile; phone/DOB/address from the
      persona bag. 409 CONFLICT when none of address/phone/email exists (a
      bare name is not an identity fill); values travel INTO the page only,
      the response names filled/missing fields, never values.
    - The CDP plumbing (connect → pick page target → attach → evaluate →
      detach) is shared with card autofill via one `evaluateOnPage` helper.
    - Tests: 6 unit (expression/parse) + 7 API (fill, targetId, name split,
      not-running 409, nothing-to-fill 409, no-page 409, 404).
      386/386 green. Remaining on §7: WPM typing simulation (item 11).
11. ✅ **WPM typing simulation** (2026-11-15, v0.14.6) — `POST
    /profiles/:id/autofill/type` types into the page's FOCUSED editable
    element (input/textarea/contenteditable):
    - One async `Runtime.evaluate` (awaitPromise): per-key delay =
      60000/(wpm·5) with ±35% jitter, 2.2x pause after space/comma/period,
      random 120–400 ms micro-pauses; native-setter + input event per key,
      change event at the end — React/Vue controlled components see a real
      typing sequence. `no-focused-field` result (typed: 0) when nothing
      editable has focus — never a throw.
    - Evaluate timeout scales with text length × worst-case per-key time,
      bounded at 300 s; `wpm` validated 20–400 (default 60).
    - The §7 Jancy-parity autofill row is now fully ✅ (card + address +
      typing).
    - Tests: 4 unit + 5 API; 395/395 green.
12. ✅ **CSV import email column** (2026-11-15, v0.14.7) — Jancy's required
    `Profile/Name/Email` trio completed:
    - Contracts: `email` joins `CreateProfileInputSchema` and
      `UpdateProfileInputSchema` (validated email, nullable — explicit null
      clears). ProfileService create/update carry it.
    - CSV import: `email` column validated per row (bad email fails only
      that row); on re-import an empty cell leaves the stored email
      unchanged — never a silent clear.
    - Tests: 3 import + 5 API assertions; Jancy §1 required-columns row ✅.
13. ✅ **Tab console depth** (2026-11-15, v0.14.8) — Tab Thinger + mass
    select + tab view:
    - `tab-thinger.ts`: `[!]field:pattern` tokens ANDed over fields
      status/url/id/partition/related/engine; `*` wildcard; bare token =
      url sugar; partition = id-prefix match; unknown field or empty
      pattern → VALIDATION_FAILED (now mapped 400 by the error mapper —
      was a 500 hole).
    - Endpoints: `POST /profiles/:id/tabs/query`, `…/tabs/bulk-close`
      (by tabIds OR query q; per-tab results, idempotent closes, one
      failure never aborts the set), `…/tabs/bulk-open` (many URLs,
      optional shared relatedTo partition, per-url results).
    - Console Tabs panel: running-profile picker, query box, tab table
      w/ checkboxes, "(all selected)", Close selected, bulk-open input;
      SSE run./tab. events refresh it.
    - Tests: 8 unit + 5 API; §4 rows updated (mass select ✅, Tab Thinger ✅,
      tab view 🟡, bulk-open 🟡).
14. ✅ **Cookie Thinger** (2026-11-15, v0.14.9) — programmable cookie
    surgery over CDP:
    - `GET /profiles/:id/cookies?domain=&name=&partitionId=` — list with
      `*` wildcard filters (case-insensitive, leading-dot tolerant);
      partition scope resolved via the partition's open tabs →
      `Target.getTargets` browserContextId → `Network.getCookies`.
    - `POST …/cookies` — set one cookie; partition-scoped sets go through
      an attached live page so they land in the partition's store.
    - `POST …/cookies/clear` — mass delete by filter; a filter-less
      whole-jar wipe is refused (400).
    - MockCdpServer grew Network.* hooks (getAllCookies/getCookies/
      setCookie/deleteCookies).
    - Tests: 8 API; §5 rows flipped ✅ (mass clearing + Cookie Thinger).
15. ✅ **Console polish** (2026-11-15, v0.14.10) — four Jancy daily-driver
    gaps closed in one batch:
    - **Proxy-provider star/default** — `starred` column on
      `proxy_providers` (migration 005); `POST /proxy-providers/:id/star`
      {starred:bool} makes one provider the default (starring clears all
      others). Console gained a Proxy providers section (star + refresh).
    - **CLI `--proxy-provider`** — `queuepilot profile start NAME
      --proxy-provider POOL` resolves the provider by name/id, takes its
      next proxy via `POST …/next`, attaches it with `PATCH /profiles/:id`,
      then starts. The proxy password never leaves the server.
    - **Favorite (star) on profiles** — `favorite` boolean rides the persona
      bag (PATCH /profiles/:id/persona); CSV `favorite` column ("1"/"true"/
      "yes" star; absent column/empty cell leaves the value);
      `GET /profiles?favorite=true` filter; console ★ toggle.
    - **Tab color** — `tabColor` (#rgb/#rrggbb, validated) rides the persona
      bag; CSV `color` column; bad color fails only that row (dry-run too);
      console color dot per profile. Engine-side tab tinting deliberately
      out of scope for the TS layer.
    - Tests: provider star (unit + API), CLI flag (live-server e2e),
      favorite/color import; 427/427 green.
16. ✅ **Jancy-gap batch** (2026-11-15, v0.14.12) — four parity rows moved:
    - **URL start pages** — CSV `url` column (`|`-separated, ≤25, bad URL
      fails the row, absent column never clears) → `extra.startUrls`;
      lifecycle opens each as a tab right after launch, OUTSIDE the launch
      lock (openTab takes the same mutex); a failed page emits
      `startpage.failed` on the SSE stream and never fails the launch.
    - **Tab sort modes** — `sortTabs` (newest/oldest/url/domain/status/
      partition; the six orderings real tab records honor) on
      `GET /tabs?sort=` and the Thinger query; console gained a sort
      dropdown. Unknown mode = 400.
    - **Staggered bulk-open** — `staggerMs` (0–10 s) waits between opens so
      a hundred-page burst doesn't thundering-herd the target.
    - **Per-partition cookie load** — `POST /profiles/:id/cookies/load`
      bulk-loads ≤500 cookies with per-cookie results, optionally scoped to
      one partition through its open tabs' contexts.
    - Tests: 34 across the three areas; parity-jancy §1/§4/§5 rows flipped.
17. ✅ **Settings** (2026-11-15, v0.14.13) — the console Settings section
    (A1 from the workspace brainstorm; Jancy classic style, see
    docs/ui-design.md):
    - **Store** — `settings` table (migration 006, one JSON document per
      section); shapes + defaults owned by `packages/contracts/src/settings.ts`
      (six sections: general / engine / launch / team / integrations /
      automation); `SettingsService` merges stored-over-defaults shallowly
      and re-validates, so a corrupted row degrades to defaults instead of
      bricking the console.
    - **API** — `GET /settings/sections` (all), `GET/PATCH
      /settings/sections/:section`; PATCH validates with per-section partial
      zod schemas, unknown section or invalid value = 400 VALIDATION_FAILED.
      Mounted under `/settings/sections/` so the section param route can
      never shadow the static `/settings/export` | `/settings/import` bundle
      routes (verified by test).
    - **Console** — Settings section after Events: subsection nav
      (general/engine/launch/team/integrations/automation) rendering
      schema-driven selects/checkboxes/inputs; every change PATCHes
      immediately ("saved automatically on change"), failed saves revert the
      form and post to the event stream.
    - **Deliberately out of scope** — the light theme CSS (schema only; the
      jancy dark theme IS the shipped look), startOnBoot wiring (schema only).
    - Tests: 10 (service defaults/merge/persistence-across-restart/rejections
      + HTTP incl. bundle-route coexistence); 456/456 green.
18. ✅ **Batch-start controller** (2026-11-15, v0.14.14) — A2 from the
    workspace brainstorm; select many profiles, start them in one action:
    - **API** — `POST /profiles/batch-start {ids, staggerMs}`: sequential
      starts honoring the per-profile launch mutex and the host capacity
      cap; one profile failing never aborts the batch (its result row
      carries the error, CSV-importer philosophy); `staggerMs` 0–60 000.
    - **Console** — checkbox on every profile card; selection lives in a
      module-level Set so SSE-driven grid reloads don't wipe it; sticky
      action bar (start selected / clear) appears at the bottom edge when
      ≥1 selected; the start delay is read from Settings → Launch
      (`batchStaggerMs`), so A1 and A2 compose without extra UI.
    - Tests: 5 (all-start, failure isolation, already-running row, stagger
      timing, input validation).
19. ✅ **Window tiling** (2026-11-15, v0.14.15) — A3: placement presets over
    the running engine windows, layered ON TOP of the stealth invariant (the
    window-fit watcher still guarantees no window exceeds the claimed
    screen; tiling only decides where windows sit):
    - **Presets** — `cascade` (equal windows stair-stepping 32/24 px,
      clamped to the work area) and `grid` (square-ish cells, fewest
      columns); pure functions `cascadeRects`/`gridRects` unit-tested.
    - **API** — `POST /profiles/:id/window/bounds` (single window),
      `POST /profiles/batch-tile {ids, preset, area?}` (per-profile result
      rows; not-running fails its row, never aborts the batch),
      `POST /profiles/batch-window-restore` (re-applies remembered geometry
      after a restart).
    - **Remembered geometry** — every applied rect persists to the typed
      persona layer (`windowBounds`, new PersonaWindowBoundsSchema); the
      console's Tile buttons therefore survive restarts via restore.
    - **Console** — "Tile cascade" / "Tile grid" buttons on the batch bar
      from A2; the two features compose (select → start → tile).
    - MockCdpServer grew Browser.getWindowForTarget / setWindowBounds +
      window-state hooks.
    - Tests: 8 (rect math x3, bounds, batch-tile, restore-after-restart,
      no-remembered row, validation).
20. ✅ **Folder/group tabs** (2026-11-15, v0.14.16) — GoLogin-style
    navigation above the profiles grid, the "future nav" slot from
    docs/ui-design.md:
    - **API** — `GET /profile-groups`: one SQL aggregate (total + running
      per group; the running count feeds the tab badges). `GET /profiles
      ?group=` filter already existed and is unchanged.
    - **Console** — "All" tab plus one tab per group, each showing
      `total · running▶`; all profiles are fetched once and filtered
      client-side so tab switches are instant; SSE reloads refresh tabs +
      grid together; batch selection (A2) survives tab switches and works
      per-tab.
    - Gotcha worth remembering: `group` is a reserved word in SQLite —
      the aggregate aliases `grp AS "group"` (quoted).
    - Tests: 3 (aggregate counts incl. running, empty list, group filter).
21. ✅ **Group management actions** (2026-11-15, v0.14.17) — groups are no
    longer create/import-time-only:
    - **Rename** — `POST /profile-groups/rename {from, to}`: one SQL UPDATE
      across the group; refuses to merge into an existing group (409
      CONFLICT — a silent swallow would be data loss by another name);
      unknown source = 404. Console: ✎ on each folder tab.
    - **Move** — `POST /profiles/batch-move {ids, group}` (one round trip
      for the batch bar; single-profile move stays `PATCH /profiles/:id
      {group}`). Moving into a brand-new name creates the tab. Console:
      group dropdown (+ "new group…" prompt) on the A2 batch bar; move
      composes with select → start → tile.
    - Tests: 5 (rename happy/merge-refused/404, batch-move, partial move).
22. ✅ **Team leases + background sync** (2026-11-15, v0.14.18) — P7.7b+c,
    the last two team-mode rows:
    - **Launch leases** — the cross-machine double-start guard. Server:
      `leases` table + `POST /leases/acquire|renew|release`, `GET /leases[/
      :profileId]`; 409 LEASE_HELD names the holder; expired leases are
      taken over unconditionally (crashed-holder cleanup via TTL, default
      60 s); a stranger's release is a no-op. Client: `TeamLeaseGuard`
      reads Settings → Team every call (unconfigured = no-op) and FAILS
      CLOSED — an unreachable server refuses the launch rather than
      skipping the guard. BrowserLifecycleService gained an optional
      guard hook: acquire before any run row is written, release on stop
      and on failed launch (lease never leaks). New contract code
      TEAM_LEASE_HELD → 409.
    - **Background sync loop** — `TeamSyncLoop` ticks every 60 s (when
      serverUrl+token+syncPassphrase are all set), pulls any bundle whose
      server revision beats the local watermark, and advances the
      watermark only after a successful import. Pull-dominant by design:
      pushes stay operator-invoked (auto-export would re-seal live cookie
      jars on a timer — a push side needs dirty-tracking, its own future
      design). Watermark keyed on the REMOTE profileId (a restored bundle
      gets a new local id); state in dataDir/team-sync-state.json,
      written atomically; a failed pull never advances the watermark, so
      the next tick retries.
    - Tests: 8 server lease (lifecycle, TTL takeover, role gating) + 3
      lifecycle guard (denied/held-then-released/failed-launch) + 4 sync
      loop (tick+skip, unconfigured no-op, bad-passphrase retry,
      restart-safe watermark).
23. ✅ **Daily-driver batch** (2026-11-15, v0.14.19) — search box,
    batch-stop, clone. The three console gaps that made big libraries
    painful:
    - **Search box** — client-side filter over the already-fetched list
      (name / email / group, case-insensitive), so typing re-renders the
      grid instantly with zero round-trips; the existing
      `GET /profiles?query=` stays as the API-side equivalent.
    - **Batch stop** — `POST /profiles/batch-stop {ids}` is the mirror of
      batch-start: sequential stops, per-profile rows, one failure never
      aborts the batch. Stop is idempotent, so an already-idle profile
      still reports `stopped` (unlike batch-start where already-running
      is a failed row — starting twice is a mistake, stopping twice is
      not). Console: "Stop selected" on the A2 batch bar; selection is
      kept after a stop.
    - **Clone** — `POST /profiles/:id/clone` (Jancy's clone): copies
      name (+" copy" unless one is given), group, email, notes, tags,
      proxy link and the persona bag, but generates a FRESH fingerprint
      identity — two profiles sharing one identityId would be a linkage
      a detector could follow. Provider linkage does NOT travel (upsert
      keys must stay 1:1 with the source row). Console: "Clone" button on
      every card with an optional name prompt.
    - Tests: 8 (clone persona/fresh-identity/provider-reset, explicit
      name, 404; batch-stop running/idle-idempotent/ghost-row/400;
      server-side query filter).
24. ✅ **Profile panel + console resuscitation** (2026-11-15, v0.14.20) —
    the profile editor UX, built on the vanilla console per ADR-0005
    (React rewrite stays deferred until the console outgrows it):
    - **Slide-over panel** — "Edit" on every profile card opens a
      right-side editor: identity (name / group / email / tags / notes /
      launch proxy) and persona (phone / dob / address line 1 / SMS
      numbers / start pages / tab color / favorite). Saves compose
      `PATCH /profiles/:id` + `PATCH /profiles/:id/persona`; the address
      object is merged (line 1 follows the input, other fields preserved).
      A "Delete profile" danger button (confirm-gated) finally exposes
      the long-existing DELETE endpoint in the UI.
    - **Console resuscitation** — `renderProfileGrid` had used `await`
      since v0.14.16 without being `async`: a module-wide SyntaxError
      that silently killed the ENTIRE dashboard script (grid, batch bar,
      settings — everything after it in the file). Fixed by making the
      function async. New `dashboard-syntax.test.ts` regression guard
      parses every dashboard .js at test time so this class of bug can
      never ship again.
    - Tests: 4 (app.js parse guard + settings/proxies parse, panel GET
      exposes every edited persona field, PATCH null-clears email+proxy
      in one call).

## v0.15 — Security hardening + daily-driver gaps (external-audit driven)

Direction approved 2026-11-15 after the dual external audit
(`docs/audits/side-by-side-2026-11-15.md`, GPT-5.2 + Claude Sonnet 5.5, all
findings grep-verified before acceptance). Sequencing: harden first, then
daily-driver Jancy gaps, then feature work. macOS/Linux port is an approved
post-usability phase. Scripts-as-plugins (JYL + plugin registry) already
exists — the cookie-warmer script drops in as a plugin later. Out of scope
for this build (deferred, revisit with real usage): RBAC/multi-user, recorder
/visual builder, PAC/proxy chaining, LocalStorage/IndexedDB in bundles.

25. ✅ **Audit P0 batch 1** (2026-11-15, v0.15.0) — the three cheapest,
    highest-severity audit items, all verified against source first:
    - **A1 SSE CORS** — removed `Access-Control-Allow-Origin: *` from
      `/events`. The dashboard is same-origin (served by this API), so it
      needs no CORS — and the wildcard let any visited website read lifecycle
      events off loopback via EventSource. Regression test pins the header
      absence.
    - **B1 Lease renewal** — the cross-machine double-start guard silently
      expired 60 s after every launch: `renewLease` existed on the HTTP
      client but nothing called it. `TeamLeaseGuard` gained `renew()`;
      BrowserLifecycleService heartbeat-calls it per live run (30 s default,
      unref'd, self-cleaning on stop/crash). Guard interface extended with
      optional `renew`.
    - **B2 Sync watermark honesty** — the background team-sync loop advanced
      its revision watermark while the bundle's cookies were still inside the
      bundle (profiles looked synced, cookies never arrived). `pullProfile`
      now reports `cookiesPending` + carries `rawBundle`; the loop holds the
      watermark back until the engine is live, then finishes the import via
      `finishPull` → `importBundle`. `SyncTickResult` gained `pending`.
    - Tests: 4 updated (new honest sync semantics, incl. restart-safe) + 1
      new lease-heartbeat + 1 new SSE header pin.

26. ✅ **Audit P0 batch 2** (2026-11-15, v0.15.0) — treat loopback as hostile:
    - **A5 Cookie redaction + opt-in raw export** — `GET /profiles/:id/cookies`
      returned raw session values to anything that could reach the port.
      Values are now `***` by default (metadata intact); `?reveal=raw` works
      only when the install runs with `SPECTRA_API_TOKEN` set — configuring a
      token IS the explicit operator opt-in. New `FORBIDDEN` error code → 403.
    - **A-rec #2 sourcePath containment** — provider refreshes and extension
      installs took caller-supplied paths, so any visited web page could have
      the API read/copy arbitrary local files. New
      `resolveContainedPath()` (resolve → per-component symlink rejection →
      containment against realpath'd roots). Production roots:
      `<dataDir>/imports` (provider CSVs) and `<dataDir>/extension-sources`
      (extension packages), both created at boot. Both provider services take
      `sourceRoots`; `ExtensionRegistry.install` enforces the same way.
    - **A-rec #1 constant-time token compare** — the bearer-token hook used
      string `!==`, leaking the token via response timing. Now
      `timingSafeEqual` over equal-length buffers.
    - Tests: new `contained-path` unit suite (10 cases: containment,
      traversal, symlink file/dir, missing tail) + cookie redaction suite
      (default mask, 403 without token, raw WITH token incl. bearer check) +
      provider/extension containment rejections; 6 existing test files
      updated to the new honest path rules.

27. ✅ **Audit P0 batch 3** (2026-11-15, v0.15.0) — code-execution surfaces:
    - **A6 Zip-bomb limits** — `unzipTo` had zero bounds. Now: 64 MB archive
      ceiling, 1,000-entry cap, 32 MB per-file inflated cap, 256 MB total
      inflated cap, each a loud failure instead of a full disk. Folder-source
      installs (`copyTree`) also drop symlinked entries instead of
      dereferencing them into the profile dir.
    - **A-rec #3 Scripting-endpoint gate** — the routes that run code or
      touch secrets (`/jyl/run`, `/jyl/rescan`, `/jyl/endpoint/*`,
      `/plugins/rescan`, `/parsers/rescan`, `/parsers/:name/run`,
      `/resolvers/run`, alias PUT/DELETE) are refused with 403 until the
      operator flips **Settings → Automation → Scripting endpoints**
      (`automation.scriptingEndpoints`, default OFF — the explicit opt-in).
      The bearer-token hook remains the auth layer on top. Read-only listing
      routes stay open. Dashboard gained the toggle.
    - Tests: 3 zip-bomb cases + 2 gate cases (403-by-default, opens after
      opt-in, read-only routes unaffected).

28. ✅ **Audit P0 batch 4 — PAN/CVV custody** (2026-11-16, v0.15.0) — the last
    v0.15.0 P0, closing the hole the auditors called out hardest: full card
    numbers AND CVVs rode in `profile.extra` in SQLite plaintext, and every
    `GET /profiles/:id` (plus team bundle exports) handed them out raw — the
    masked `/cards` endpoint was decoration, not a boundary.
    - **PANs → SecretStore** (new `card-secrets.ts`): persona PATCH and
      provider CSV import both seal on write — PAN lands in DPAPI under
      `card:<profileId>:<set>:number`, the row keeps last4 + fill metadata
      only. Autofill re-hydrates the PAN at fill time; clones copy the secret
      under their own profile id.
    - **CVVs never stored** — discarded at the seal, on every write path; a
      fill simply has no CVV to type. Purged from legacy rows by the boot
      migration.
    - **Reads safe by construction** — the row cannot leak what it no longer
      holds; `personaFieldsOf` now returns the stored metadata shape.
    - **Boot migration** — `migrateLegacyCardStorage` lifts pre-v0.15 PANs
      into the SecretStore and reports the count at startup.
    - Honest consequence: team bundles now sync card METADATA only (last4) —
      PANs are per-machine by design.
    - Tests: new `card-secrets` suite (seal/storeless-drop/idempotent/prune/
      resolve/clone/migration) + raw-read leak checks on GET profile, list,
      and /cards.

**v0.15.0 security hardening is COMPLETE** — all nine audit P0/P1-security
items shipped (batches 1–4).

## v0.15.1 — Daily-driver gaps (all five shipped 2026-11-16)

1. ✅ **Cookie import/export** (`c9093ec`) — `POST /profiles/:id/cookies/import`
   (body `{format, content, partitionId?}`) + `GET /profiles/:id/cookies/export?format=netscape|json`.
   Netscape tab-file and JSON formats both ways; per-cookie results on import;
   export values redacted to `***` unless `reveal=raw` on a token-configured
   install (same rule as the list). Parse errors are 400 VALIDATION_FAILED,
   never 500.
2. ✅ **Trash/restore** (`19b56c1`) — migration 007 adds `profiles.deleted_at`;
   `POST /profiles/:id/trash`, `POST /profiles/:id/restore`,
   `GET /profiles/trash`, `DELETE /profiles/:id/trash` (purge — wipes the row
   AND its card PAN secrets from the SecretStore). Live queries filter
   `deleted_at IS NULL`, so a trashed profile is invisible to lists, gets,
   group counts AND launches. Provider-key lookup skips trashed rows, so a
   provider refresh re-imports as a FRESH profile instead of colliding with
   the unique index. Refuses (409) while the browser runs.
3. ✅ **Proxy validation, real** (`4f3d4d0`) — `test()` was a bare TCP connect;
   it now makes an actual request THROUGH the proxy to a geo-IP echo
   (`proxy-probe.ts`) and reports `{ok, latencyMs, error, exitIp, geo}` with
   country/region/city/timezone. http/https (absolute-URI GET) + socks5
   (handshake, auth when creds set) supported; 407 surfaces as a clear auth
   failure. Probe URL injectable for tests.
4. ✅ **Fingerprint field pinning** (`e88e088`) — migration 008 adds
   `fingerprint_identities.overrides`; `GET/PATCH /profiles/:id/identity`.
   The PATCH body REPLACES the pin bag: partial pins those fields, `{}` clears
   back to seed-derived. Pins merge on READ inside the repository, so launch,
   snapshot, drift and attestation all see the effective identity; the
   seed-derived row underneath never mutates, regenerate still works. Pin-able:
   platform, screen, hardwareConcurrency, deviceMemoryGb, timezone, locale.
   UA/WebGL/fonts are NOT pin-able — the fury persona schema derives them at
   the engine; pinning them needs an engine-side knob (fury persona v2), not
   storage that lies. Seed is never pin-able (strict schema, 400).
5. ✅ **Dashboard batch endpoints** (`ab26a74`) — `POST /profiles/batch-state`
   returns `{id, drift, tabCount}` for up to 1000 profiles in ONE request,
   per-profile failures isolated (null entry, never a failed batch). The grid
   now makes 1 request per refresh instead of 2N — the N+1 that fell over
   past a few dozen running profiles on every SSE event (audit B4).

**v0.15.1 daily-driver gaps are COMPLETE.** All gates green: 565 API tests +
18 server tests, clean typecheck and build. Next candidates: proxy health
HISTORY (validation results over time — out of scope above by design), fury
persona v2 (UA/WebGL/font pins), or the next numbered P-roadmap item.

## v0.16 — Expansion batch (owner-approved 2026-11-16, all seven items)

1. ✅ **Jancy parity gate — PASSED** (`7828688`) — `docs/parity-jancy.md`
   re-verified row-by-row against v0.15.1; stale rows updated (profile panel,
   per-launch rotation now in build, provider trash annotated); remaining gaps
   classified as in-build / owner-approved deferrals / plugin-shaped content.
2. ✅ **Warmup recorder + player** (`97dad9f`) — P3 closed. Record a live
   profile's URL/dwell sequence (`POST /profiles/:id/warmup/record`,
   poll-based, runtime-agnostic), replay for cookie warming
   (`POST /warmups/:id/run`, ±20% dwell jitter, per-step error isolation,
   starts idle profiles, leaves them running unless `stopAfter`).
3. ✅ **External checker harness** (`9461a30`) — P4's manual leg scripted:
   `scripts/detection-check.mjs` launches a profile, opens CreepJS +
   sannysoft staggered, snapshots the attestation verdict + engine/proxy
   identity beside them, writes a sign-off report under `docs/reports/`.
   One visual review per engine bump remains (needs human eyes on a
   fury-core machine).
4. ✅ **Team mode complete** (`d8258cb`) — P5 closed. The 2026-11-14 P7.7
   track had already delivered the server (roles, hashed tokens, bundle
   mailbox, optimistic concurrency, multi-user leases with TTL takeover);
   this batch added the last ops gap: admin **force-release** of stuck
   leases (`DELETE /leases/:profileId`, admin-only; operator/viewer 403).
5. ✅ **Proxy health history** (`57bcc0b`) — migration 009 `proxy_health`;
   every `test()` records ok/latency/exitIp/geo/error, newest-200 retention
   per proxy, FK cascade on proxy delete. `GET /proxies/:id/health?limit=N`.
6. ✅ **Engine-level fingerprint pins** (`dbea36e`) — the fury patchset reads
   `navigator.userAgent` (0011), `fonts`/`fontsHidden` (0050-0052) and
   `gpu.webglParams.UNMASKED_*` (0031) from the persona config, so the
   overrides bag now carries real UA / font-list / WebGL vendor+renderer
   pins. `personaConfig` emits exactly those keys when pinned, omits them
   when not (absent = real value on the engine). Schema stays strict —
   unknown pin keys are 400. Camoufox/fake runtimes ignore pins they have no
   reader for.
7. ✅ **Proxy rotation links** (`6a1ede3`) — D-003 closed. A profile links to a
   proxy provider's pool via `profile.extra.rotationLink`
   `{providerId, mode}` — **rotate** = per-launch pool pick (cursor advances
   under start-over distribution), **persist** = stable cursor entry. Launch
   precedence: tempProxy > attached proxyId > proxy-list entry > rotation
   link > direct. A configured link with no provider service wired REFUSES
   launch (`VALIDATION_FAILED`) — never a silent direct connection. The
   resolved endpoint lands in the launch snapshot with `proxySource:
   "rotation"` and `snapshot.proxyId` = the resolved proxy, so drift while
   running reports "the next launch may resolve a different proxy". Routes:
   `PUT/GET/DELETE /profiles/:id/rotation-link` (PUT 404s on an unknown
   provider). 5 new tests; 586 API + 20 server green; monorepo typecheck
   clean again (also fixed four older typecheck regressions from items 2/5a
   that the test-only gates had missed).
8. ✅ **Default engine = fury + host-memory clamp** (this commit) — three
   outcomes from the 2026-11-16 external battery (report:
   `docs/reports/detection-check-2026-11-16.md`):
   - (a) `config.runtime` default flipped `camoufox` → `fury`. Fury is our
     fully-owned engine and passed the whole battery; camoufox remains
     available via `SPECTRA_RUNTIME=camoufox`.
   - (b) D-004 / AliasMode external checker: **passed** (0 problems, 23
     checks green) after pinning the test profile timezone. deviceMemory
     warning **FIXED** — `generateIdentity` now takes the host's physical
     RAM (`hostMemoryGb()` in `host-display.ts`) and clamps the deviceMemory
     pool to buckets ≤ host RAM, so the claimed value can never be
     contradicted by the V8 heap limit page JS can read. All 6 generation
     call sites wired. Caveat recorded: team-synced profiles moving across
     machines with different RAM could mismatch again (same class as the
     screen clamp).
   - (c) **canvas palette — FIXED same day (qp.4, commit 3c89fc9 + manifest
     bump).** Root cause found by reading the AliasMode checker source: it
     draws shapes (arming `FuryWantsCanvasNoise`), then `putImageData()`s a
     known 64x64 pattern, reads it back and counts differing pixels. Real
     Chrome round-trips putImageData byte-for-byte; our position-pure noise
     noised the whole pattern ("canvas pixels change after a shape is
     drawn"). Fix: the host tracks putImageData rectangles
     (`FuryNoteExactRect`, cap 64, cleared on reset) and every readback path
     (getImageData, toDataURL, toBlob, convertToBlob, workers) skips noise
     inside them. Same-canvas `toDataURL` twice, cross-realm hashes and
     seed-stability unchanged by design. Engine rebuilt in 23 min;
     verify-0030 grew claim 10 (putImageData round-trip) — 21/21 PASS;
     packaged as fury-core **0.5.5-qp.4** and re-run live:
     **AliasMode /check: 0 problems, 0 warnings, 23 passed — fully green.**
     The identical cross-context hash was never the problem: the checker
     only warns when realm hashes DIFFER, and stock Chrome agrees across
     realms too. Also found live: the detect-test profile still carried a
     pre-clamp deviceMemory=4 pin; patched to 8 (32 GB host). Two follow-ups:
     identity PATCH replaces `overrides` instead of merging (timezone pin
     was lost on the first PATCH — v0.16 item 9), and legacy profiles keep
     stored personas that predate the host clamp (one-line PATCH each, or
     regenerate).
9. ✅ **Identity PATCH must merge overrides** — found during the qp.4
   verification: `PATCH /profiles/:id/identity {"deviceMemoryGb":8}` silently
   dropped the existing `timezone` override. Fixed in `f9398c3`: merge, don't
   replace — absent field keeps its pin, value sets one pin, explicit `null`
   clears one pin back to seed-derived, empty body is a no-op, regenerate
   clears all. Regression test locks the merge behavior.

## v0.16.1 — Audit fixes, GPT-5.4 findings 1–4 (owner-approved 2026-11-16)

Report: `docs/reports/audit-gpt-5.4-2026-11-16.md`. All four findings
fixed in `347d885`; 598 API + 20 server tests green; tsc + build clean.

1. ✅ **Scripting/JYL/plugin RCE surface** (the audit's only High) —
   scripting endpoints now demand a credential boundary on top of the
   settings opt-in: without `SPECTRA_API_TOKEN` every scripting route 403s
   (request-time gate), the dashboard toggle refuses to enable them, and
   `main.ts` logs a loud boot warning. Plus a deny hook that 403s any
   cross-site (`Sec-Fetch-Site`) or cross-origin (`Origin` ≠ Host, non-
   loopback) request to `/jyl /plugins /resolvers /parsers /aliases`
   before handlers run — a web page inside any profile browser can no
   longer reach code-executing endpoints. Dashboard (same-origin) and
   header-less CLIs unaffected.
2. ✅ **CDP connection leak** — `WindowTilingService` opened a
   `CdpConnection` per tiled window and never closed it. Now a
   `driverHandle` closed in `finally`; regression test asserts the mock
   CDP server sees zero open sockets after a tiling pass.
3. ✅ **Structured logging/metrics** — pino via Fastify options (level via
   `SPECTRA_LOG_LEVEL`, silent in tests), request IDs on every line,
   in-process counters, `GET /metrics`, 5xx lines logged with reqId.
4. ✅ **Security mediums** — Google OAuth pending flows (PKCE verifiers)
   moved from plaintext `oauth-pending.json` into the DPAPI SecretStore
   (legacy file migrated once and deleted); team-server `/health` returns
   `{ok:true}` only to unauthenticated probes (metadata behind the bearer
   token); team-sync watermark file written `0o600`; session-bundle
   PBKDF2 (310k iterations) moved off the event loop (`createSessionBundle`
   /`openSessionBundle` now async).
5. ✅ **Stability batch** (`e90e073`) — SSE dead clients pruned on every
   broadcast + 30s heartbeat (interval cleared on close); plugin
   `store.json` read-modify-write serialized through a per-file write
   chain (concurrent sets no longer drop keys); `withTimeout` timer
   declared honestly; `parseCsv` keeps embedded newlines in quoted fields
   and normalizes CRLF→LF; new `writeFileAtomic` (tmp + fsync + rename +
   dir fsync) applied to launch snapshots, bookmark sets, team-sync
   watermark, and oscrypt.key — power-loss durable; proxy latency read
   once instead of twice.
6. ✅ **Stale `docs/parity.md` corrected** (`e90e073`) — egress diagnostics,
   extensions registry, TOTP, portable bundles, cookie Netscape/JSON +
   trash/restore, and the warmup recorder were BUILT but marked missing.
   The only genuinely-missing Jancy row left is **xlsx import**.

The GPT-5.4 audit is now fully actioned (findings 1–6). Finding 7's
"worth building later" Jancy-parity items — tab ops depth, warmup console
UX, xlsx import — remain the only open parity gaps, all owner-priority
calls.

## v0.16.2 — xlsx import (2026-11-16)

✅ **The last ❌ row on the Jancy parity sheet is closed** (`3408090`).
`POST /profiles/import-xlsx` runs the first worksheet through the same
row pipeline as CSV (one mapping, one report shape); the dashboard file
picker auto-routes by extension. `docs/parity.md` now has **zero missing
rows** — every Jancy capability is ✅ or an annotated owner-approved
deferral. Remaining optional parity polish (not gaps): tab-ops depth and
warmup console UX.

## v0.14 — Persona fields / 2FA layer (first item)

See P7 Jancy-gap item 5 above for sub-steps and goal. The v0.14 list is
now complete: WPM typing shipped in item 11, and the profile panel UX
shipped in item 24 on the vanilla console (ADR-0005's React rewrite
remains optional and deferred — revisit only if the console outgrows
vanilla).

## P5.6 — Perf & startup

Folded into the P7 numbered list (item 12) with sub-steps and goal.


## v0.16.3 — Phase 1 release hardening (2026-11-16, shipped in `300d849`)

Owner-approved Phase 1 of the release-hardening plan: prove the product the
way a family member uses it, package the entry point, and hand the repo to
the next builder cleanly. The E2E gate earned its keep immediately — it
found and fixed two real-engine CDP defects that all 605 unit tests could
not see (they run against the fake runtime).

1. ✅ **Scripted fresh-install E2E run** — `scripts/e2e-smoke.mjs`. One
   command boots the API on a scratch data dir + scratch port
   (`SPECTRA_RUNTIME=fake`, `NODE_ENV=production`) and walks boot →
   security gates (scripting 403 without opt-in AND without token) → CSV +
   xlsx import (dry-run → apply → upsert) → surface (`/metrics`,
   identity-PATCH merge, garbage-xlsx 400) → teardown (SIGTERM exit,
   scratch cleanup). `--launch` additionally drives the REAL fury engine on
   the live 50325 install: start → /egress → cookie jar over CDP → stop →
   no run after stop. Plain run is CI-safe (no browser windows).
   **E2E GREEN — ship it.** Two real bugs found by the launch phase and
   fixed in `300d849`:
   - *Bare `ws://host:port` CDP endpoint rejected.* FurySession publishes a
     bare `ws://127.0.0.1:<port>`; Chromium only upgrades WebSocket on
     `/devtools/browser/<id>`, so every cookie/tab op failed with an empty
     "CDP connection error". `CdpConnection.connect` now resolves the real
     `webSocketDebuggerUrl` via `/json/version` (path-ful endpoints like
     the fake runtime's are untouched; any resolution failure falls back
     to the URL as given).
   - *`Network.*` called on the browser-level socket.* Real Chromium serves
     page domains only on attached page sessions ("wasn't found"). New
     `cdp-page-session.ts` (`attachPageSession` — reuses the first open
     page, creates a transient `about:blank` only when the browser has no
     page, closes it on release); `cookie-thinger` and the bundle
     export/import transport now route every `Network.*` call through a
     page session. Partition scoping semantics preserved
     (`Network.getCookies { browserContextId }` per context, deduped).
2. ✅ **Family packaging — start script** — `scripts/start-queuepilot.cmd`.
   Dependency-free Windows entry point: checks Node is on PATH, detects an
   already-healthy API (opens the dashboard only), otherwise spawns the API
   minimized (log `%USERPROFILE%\.queuepilot\api.log`), polls `/health` up
   to 60 s, prints the log tail on failure, opens the dashboard on success.
   Cold-start tested live end to end (the first cut had a `%~dp0` root bug
   caught by this very test).
3. ✅ **Docs handoff pass** — README gains a "Handoff for the next LLM /
   agent" section: the mission (Fury engine + AliasMode lifecycle + Jancy
   workflow, personal/family use), the locked decisions (ADR-0005 vanilla
   dashboard, fury default runtime, cookie redaction, CDP session
   discipline), the pre-commit gates, the standing no-checkbox-without-
   code+tests+docs+live-verify rule, and the current Phase 2 next steps.
   Stale default-runtime references corrected (README said camoufox;
   config has said fury since v0.13).
4. ✅ **Dev API restarted with the new gates** — live on 50325 with pino
   logging + `/metrics` counters; scripting endpoints correctly 403 there
   (family-machine default runs without `SPECTRA_API_TOKEN`).

Gates at ship time: 605/605 API tests, 20/20 server tests, `tsc --noEmit`
clean, `npm run build` clean, E2E GREEN in both modes. Phase 2 next steps
(D-002 follow-ups, warmup console UX, tab-ops depth, canvas cross-context
engine item) are queued in the release-hardening plan.

## v0.16.4 — Console ops redesign (2026-11-16, shipped in `2c6d021`)

Owner rejected the stacked-section console ("does not look like the image
we agreed to") — rebuilt to the agreed GhostBrowser-pro-grade reference,
still vanilla zero-build (ADR-0005 unchanged):

- ✅ **Sidebar views** — Profiles/Proxies/Tabs/Cookies/Providers/Events/
  Settings with keyboard shortcuts (P/X/T/C/V/E/G, `/` = search) and a
  live engine/google/SSE status block.
- ✅ **Top action bar** — + New Profile, Import (CSV/xlsx drawer), Export
  (client-side CSV of the visible list), Start/Stop/Delete on the
  selection, and live PROFILES/RUNNING/IDLE/STOPPED/ERROR counts.
- ✅ **Profiles as a professional table** — row numbers, status dots,
  proxy endpoint, group chips, per-row tab counts (batch-state), icon row
  actions (start/stop/edit/clone/regen/delete), client-side pagination
  (20/50/100, persisted). Batch bar floats bottom-center; setup checklist
  is a dismissible first-run banner.
- ✅ **Cookies view** (new) — load jar from a running profile, Netscape/
  JSON import + export, domain-scoped clear; wired to the v0.15.1 cookie
  endpoints, redaction respected.
- ✅ **Settings in the sidebar** — six-section sub-nav laid out as a neat
  grid; Integrations gains a read-only Email resolvers card documenting
  the `gmail`/`imap://` URL shapes (IMAP lives in the scripting resolver
  layer — there is no writable IMAP settings endpoint to wire).

Verified live in the browser (profiles + settings screenshots), one real
boot bug found by the visual pass (topbar actions never rendered at boot —
`setView` was only called on click) and fixed. Gates: dashboard-syntax
guard green, 605/605 API tests, build clean.


## Phase 2 — D-002 PID-reuse hardening follow-ups (DONE 2026-11-17, branch `d002-followups`)

D-002 (P7 item 8a) checked the process-start token exactly once, in
`reconcileOnBoot`. Runs adopted after an API restart have no in-memory
session, which left the gaps below. Windows only for now; macOS has no
`/proc`, so its token is always null (plain liveness) until the
macOS/Linux port phase. Every box: code + tests + docs + live verification
+ commit hash.

- [x] **Three-way identity result** (`bdf006b`) — `checkProcessIdentity`
  answers `match` / `mismatch` / `unknown` / `dead` instead of a boolean,
  so an unreadable start time is no longer indistinguishable from a proven
  match. Unverified adoptions are logged and counted in `/metrics`
  (`runsAdopted`, `runsAdoptedUnverified`, `runsReconciledCrashed`). Launch
  capture rejects a token that predates the run's own `startedAt` (a
  stranger that inherited the PID between spawn and capture).
- [x] **Identity-safe stop for adopted runs** (`8b71646`, hardened in
  `adb0b32`) — `stop()` on a run with no session used to mark the row
  stopped and leave the engine running. Now: CDP `Browser.close` on the
  stored endpoint first; kill by PID only when the token proves the process
  is ours, re-proven immediately before every kill; otherwise never kill,
  and say so in `lastError`. Behavior change (owner-approved): Stop on an
  adopted profile closes its browser window.
- [x] **Adopted-run watcher** (`85f192e`) — sessionless running runs are
  re-checked on an unref'd timer (liveness every 15 s, start-token identity
  every 4th tick); a dead or PID-reused engine is marked crashed through
  the same path as boot reconciliation instead of reading "running" until
  the next API boot. The timer exists only while adopted runs do.
- [x] **Batched boot capture** (`1fea755`) — one start-token read for all
  occupying PIDs at boot (and per watcher identity pass) instead of one
  blocking PowerShell spawn per run. Same invocation style as the
  single-PID capture, which is untouched.
- [x] **Docs** (`1fea755`) — `docs/architecture.md` invariant 5 rewritten
  and invariant 6 added; `docs/parity.md` process-identity row updated.

**Live verification, 2026-11-17, fury-core 0.5.5-qp.4.** Run against a
SCRATCH API (this branch, port 50477, its own data dir). Every API process
killed was the scratch instance, its PID read from the port-50477 listener
before each kill; the live API on 50325 was never addressed and answered
`/health` 200 afterwards.

| Check | Result |
| --- | --- |
| Start → kill API → restart | `recovery: adopted=1 (unverified=0) crashed=0`; `/metrics` `runsAdopted: 1`; profile `running` |
| Stop the adopted run | engine PID gone in 1.5 s (CDP `Browser.close`), `lastError: null`, profile `idle` |
| Start → kill API → tamper `process_token` → restart | `adopted=0 crashed=1`, `lastError` "engine PID was reused by another process (start token mismatch) at API startup", profile `idle`; engine still alive 162 s later — nothing killed |
| Adopted run, engine closed out-of-band | watcher marked it `crashed` ("adopted engine process exited") 13 s later |
| Start → kill API → `process_token` NULL → restart | `adopted=1 (unverified=1)` + the per-run warning line; Stop closed it over CDP, `lastError: null` |
| Adopted run with its CDP endpoint made unreachable → Stop | token-proven PID path: engine gone in 13 s (graceful request timed out, forced kill finished it) |

Notes from the run, recorded honestly:
- In the first tampered-token run the un-adopted engine exited by itself
  about a minute after boot, cause not determined; the rerun (the row
  above) stayed alive for the full 162 s watch. No kill exists on that
  code path.
- On the PID path the graceful `taskkill` (WM_CLOSE) did not close the
  adopted engine within the 10 s grace, so the forced kill ended it. That
  path only runs when the DevTools endpoint is unreachable while the
  process is alive.
- A second-opinion review (GPT-4o) found one real gap — the graceful kill
  ran on identity proven before the CDP wait — fixed in `adb0b32`.

Gates on the final branch (run in an NTFS worktree; the `D:` volume is
FAT32 and cannot hold npm workspace links): 626/626 API tests, 20/20
server tests, `tsc --noEmit` clean, `npm run build` clean. Known flakes on
this machine, both present on untouched `main`: an intermittent
`ECONNRESET` in `tests/proxy-relay.test.ts`, and vitest workers
occasionally dying with "Worker exited unexpectedly" (seen in the untouched
server suite about 1 run in 6). The `window-tiling` ECONNRESET flake had
the same shape and is fixed by the mock-CDP-server change in `adb0b32`.

Open after this item: Phase 2 continues with warmup console UX, tab-ops
depth, and the canvas cross-context engine item.

## Phase 2 item 2 — Warmup console UX (DONE 2026-11-17, branch `warmup-console`)

The warmup recorder + player shipped API-only in v0.16.0 (`97dad9f`); the
console had no way to reach it. Standing rule applies: a box is ticked only
with code + tests + docs + live verification + the commit hash.

- [x] **Warmups view in the ops console** (`300caca`) — sidebar entry
  (shortcut `W`, between Cookies and Providers), recipes table (name, steps,
  total dwell, created, Run / Delete with confirm), record controls for a
  running profile with an in-progress countdown while the request is held
  open, and a run modal (any profile, stop-after, elapsed timer, per-step
  results). Dashboard only — no API change, no new CSS tokens. New
  `dashboard-views` wiring guard: every view has its section, nav button and
  a unique shortcut matching its `<kbd>` hint; every id app.js looks up
  exists.
- [x] **Body-less console requests fixed** (`04b6efd`) — found by this
  item's live check. The console's `api()` helper sent
  `content-type: application/json` on every request since v0.8.0
  (`df45475`); Fastify answers a body-less request that claims JSON with a
  500, so every body-less button failed: profile delete, profile stop, proxy
  test, provider refresh, tab close, and the new recipe delete. The header
  is now sent only with a body. New `dashboard-api-helper` test runs the real
  `api()` source against the API — it fails on the old helper with the exact
  live error and passes on the fix.

**Live verification, 2026-11-17, live API on 50325 (current `main`), fury,
throwaway profiles only.** The live API serves the dashboard from the
working copy on `main`, so this branch's three dashboard files were served
by a small static preview on port 50478 that forwarded every API call
unchanged to 50325 (no database, no engine; stopped afterwards). No API
restart was needed or done.

| Check | Result |
| --- | --- |
| `W` opens Warmups; running-profile picker | only the running throwaway profile listed |
| Record 25 s while two real pages were opened | button disabled with countdown; recipe saved: 2 steps (`example.com`, `example.org`), 36 s total dwell; list refreshed |
| Run on a second, idle throwaway profile with stop-after | button disabled with elapsed timer; 2/2 steps ok with dwell shown; "profile was started by this run"; profile ran and was back to `idle` (run `stopped`, `lastError: null`) |
| Recipe Delete (first build) | **failed** — HTTP 500 "Body cannot be empty…" → fix `04b6efd` |
| After the fix: record 20 s, then Delete from the table | confirm shown; recipe gone; empty state back |
| After the fix: profile Stop and Delete from the Profiles table | profile stopped (`idle` on the API), then deleted (404) |

Clean-up: all three throwaway profiles and both test recipes deleted; the
existing `detect-test` profiles were never touched.

Gates on the final branch: 639/639 API tests (626 + 10 view wiring + 3 api
helper), 20/20 server, `tsc --noEmit` clean, `npm run build` clean.

## Phase 2 hardening — adopted-proxy guard, console smoke, flakes, canvas re-check (DONE 2026-11-17, branch `phase2-hardening`)

Follow-ups the owner approved after the warmup console. This branch merges
`warmup-console` (the console smoke needs its `api()` fix `04b6efd`), so
merge `warmup-console` first or merge this branch alone — both carry it.
Every box: code + tests + docs + live verification + the commit hash.

- [x] **Adopted proxied engine: dead relay port held** (`a4a38ed`) — live
  finding below. `holdRelayPort()` placeholder (502 to everyone, port kept
  from any other process); `guardAdoptedRelays()` at boot; released on
  stop/crash; `/profiles/:id/egress` gains `relay` + `note`; `/metrics`
  gains `relaysHeld` / `relaysUnguarded`. 7 tests. Architecture invariant 7.
- [x] **Console shows a lost relay** (`afee572`) — `batch-state` carries
  `relay` per profile and the Profiles grid badges the row "proxy lost —
  restart" (held) or "proxy port taken — stop now" (unguarded). Live:
  proxied launch → scratch API killed and restarted → the grid row shows
  "proxy lost — restart" → Stop closed the engine. 1 test.
- [x] **Console smoke in a real browser** (`da4349b`) — `e2e-smoke` phase 4b
  (`scripts/console-smoke.mjs`) loads the dashboard in a headless Chromium
  over CDP (no new dependency) and clicks Start, Stop, Delete, W → Warmups,
  recipe Delete, checking each effect through the API and that the page
  threw nothing. Owner lifted the `scripts/` guard for this item.
- [x] **proxy-relay ECONNRESET flake** (`7bd8d1f`) — test fixtures, not the
  relay: the fake upstreams' sockets had no error listener. 3/12 runs red
  before, 0/15 after.
- [ ] **vitest "Worker exited unexpectedly"** — NOT fixed. Seen in both
  suites on untouched `main` too (server suite about 1 run in 6 once,
  0/20 isolated today). No `node.exe` crash event and no Defender
  detection in the last two days; no test kills a PID it does not own.
  Most likely the worker process is ended from outside (endpoint AV is a
  candidate, not proven). Left open rather than masked with retries.
- [x] **Canvas cross-context item** — already fixed in fury-core
  0.5.5-qp.4 (`3c89fc9`, manifest `c6553ea`); this item's docs were stale.
  Re-verified 2026-11-17 on the installed qp.4 binary:
  `engine/verify/verify-0030.py` **21/21 PASS**, including the putImageData
  round-trip AliasMode checks (0 of 16384 bytes differ) and both controls.

**Live verification — adopted proxied engine (2026-11-17, fury qp.4,
SCRATCH API on 50477 with its own data dir; every API process killed was
the scratch instance, PID read from the 50477 listener; the live API on
50325 was never addressed).** A recording upstream proxy (basic auth) on
127.0.0.1:50490 stood in for a real proxy.

| Check | Result |
| --- | --- |
| Proxied launch, navigate (API alive) | page loads; upstream saw the CONNECTs |
| Kill API, navigate a fresh URL (`main` code) | `ERR_PROXY_CONNECTION_FAILED`; upstream saw nothing — **fails closed** |
| Credential-free proxy bound on the dead relay port, navigate | **page loads through it** — the squatter received the CONNECTs |
| Restart API on this branch | `recovery: … held=1 unguarded=0`; a squatter bind now gets `EADDRINUSE` |
| Navigate a fresh URL | `ERR_TUNNEL_CONNECTION_FAILED`; upstream saw nothing |
| `GET /profiles/:id/egress` | `relay: "lost-held"` + note; `/metrics` `relaysHeld: 1` |
| Stop the adopted run | engine gone, `lastError: null`, port released |

**Console smoke control:** against the old `api()` helper (`300caca`)
phase 4b goes RED on Stop, Delete and recipe Delete; on this branch GREEN
(headless fury qp.4, Chrome/157).

**Found, not fixed (outside this item — recorded, not yet scheduled):** launch
snapshots under `<dataDir>/snapshots/` store the launch proxy URL with
its password in plain text (`launch-identity.service.ts` writes
`args.proxyUrl` verbatim), although proxy passwords have lived in DPAPI
since v0.12.5. The API response redacts it; the file does not.
**→ Fixed** in "Snapshot proxy passwords at rest" below (`6cc63f7`).

Gates on the final branch: 647/647 API tests, 20/20 server, `tsc
--noEmit` clean, `npm run build` clean; `node scripts/e2e-smoke.mjs` GREEN
including phase 4b.

## Phase 2 — Tab-ops depth, slice 1 (DONE 2026-11-17, branch `tab-ops-depth`)

Built on `phase2-hardening` (the console needs the `api()` fix). Merge
order: `warmup-console` → `phase2-hardening` → `tab-ops-depth`, or this
branch alone (it carries both).

- [x] **Per-tab reload, auto-reload, duplicate, screenshot** (`16cf765`) —
  `POST …/tabs/:tabId/reload`, `POST …/auto-reload {intervalSec: 0 | 5–3600}`,
  `POST …/duplicate` (related tab → same session partition),
  `GET …/screenshot` (image/png). Real engines attach to the tab's target
  and send `Page.*` on that page session, then detach. Auto-reload is
  in-memory and dies with the tab, the run or the engine. Console Tabs view:
  per-row ↻ / ⎘ / 📷 / ✕ and an auto-reload picker; screenshots open in a
  drawer. 7 tests. Parity-jancy §4 rows updated.
- [x] **Real-process test budget** (`11cb553`) — the adopted-stop suites
  get 60 s per test; one loaded full run pushed a relay test past 30 s.

**Live verification (2026-11-17, fury qp.4, scratch API on 50477 with its
own data dir, throwaway profile, console served by that API):**

| Check | Result |
| --- | --- |
| Tabs view row | ↻ ⎘ 📷 ✕ actions + auto-reload picker on the open tab |
| ↻ Reload | page `performance.timeOrigin` moved forward (a real reload) |
| Auto-reload 15 s | listed `autoReloadSec: 15`; origin advanced by 15.0 s between reloads |
| Auto-reload off | origin unchanged over the next 20 s |
| ⎘ Duplicate | second open tab, same URL, same partition (`66fc37a4`) |
| 📷 Screenshot | drawer opened with a 1334×585 capture of the page |

Still open on parity-jancy §4 (not in this slice): per-tab move /
set-color / set-profile / timezone, named windows + max tabs/window,
closed-tab restore, Tab Studio, proxy-matched bulk-open, tab strings.

Gates: 654/654 API tests, 20/20 server, `tsc --noEmit` clean, `npm run
build` clean.

## Phase 2 — Snapshot proxy passwords at rest (DONE 2026-11-17, branch `snapshot-proxy-redact`)

Built on `tab-ops-depth`. Closes the "Found, not fixed" note in Phase 2
hardening above.

- [x] **Snapshots never store the proxy password** (`6cc63f7`) —
  `LaunchIdentityService.capture` writes `stripProxyPassword(proxyUrl)`:
  scheme, username, host and port are kept (`http://alice@10.0.0.1:8080`),
  the password is dropped. It works on the string, so credential-free URLs
  are stored byte-identical; any other `@`-bearing shape becomes
  `(unparseable proxy url)` rather than risk keeping a secret. The engine
  still gets the full URL — only the snapshot copy is stripped.
- [x] **Boot migration** — `stripStoredProxyPasswords()` runs in `main.ts`
  before recovery and rewrites (via `writeFileAtomic`) only the snapshot
  files that still carry a password. Idempotent; an unreadable file is
  logged and skipped, never a reason to abort boot.
- Readers checked by grep — none needs the password: `egressDiagnostics`
  re-redacts for the API, `relayStateFor` / `guardAdoptedRelays` only test
  that a proxy URL exists and read `egress.relayPort`, `computeIdentityDrift`
  reads `proxyId` / `proxySource`, `gridState` / `attest` don't touch the URL,
  and bundles never read snapshots.
- Tests: stripper unit cases, migration (rewrites one, leaves the clean file
  byte-identical, skips a corrupt file, second run rewrites nothing, relay
  port survives), egress + drift from a stripped snapshot, and temp-proxy
  asserts the engine still received the password while the file has none.

**Live verification (2026-11-17, fury qp.4, scratch API on 50491 with its
own data dir, local auth proxy on 50492; live API on 50325 untouched):**

| Check | Result |
| --- | --- |
| Boot with a legacy snapshot holding `legacy:<password>` | log `proxy passwords stripped from 1 file(s), 0 unreadable`; file now `http://legacy@10.9.9.9:3128` |
| Proxied launch through the password-protected proxy | running; proxy saw 10 authenticated requests, 0 denied |
| New snapshot file | `"proxyUrl": "http://verify@127.0.0.1:50492"`; password string found in 0 snapshot files |
| `GET /profiles/:id/egress` | `http://***@127.0.0.1:50492/`, exit IP measured, `relay: "live"` |
| `GET /profiles/:id/drift` · stop | `stale: false` · stopped cleanly |

Gates: 657/657 API tests, 20/20 server, `tsc --noEmit` clean, `npm run
build` clean.

## Console ops — owner feedback batch (2026-11-17, branch `console-ops`)

Owner could not add or remove proxies, select all profiles, create
groups, or add Gmail accounts for the IMAP resolver from the console.

- [x] **Profiles select-all + New group** (`859d597`) — header checkbox
  selects every profile in the current view (all pages, group + search);
  '+ New group' names a group for the selection. The batch bar's Move menu
  already had '+ new group…', but without bulk selection it was easy never
  to see it. Groups exist through their members (no empty groups).
- [x] **Proxies: add, paste a list, remove, select all** (`859d597`) —
  drawer accepts `host:port`, `host:port:user:pass` and
  `name:host:port:user:pass` lines (optional scheme prefix; ':' allowed in
  passwords); per-line results never echo a line back; per-row delete,
  select-all, Test selected, Delete selected; test results show exit IP and
  location. No API change.
- [x] **Email accounts for the IMAP resolver** (`706d483`, form layout fix
  `a73ac5e`) — Settings → Integrations: add several Gmail/IMAP accounts
  (email, app password, server, port), Test login, Remove. Password only in
  the SecretStore, write-only; `imap:you@gmail.com` resolves through a
  stored account. Separate from `/aliases`: the scripting lock is
  unchanged.

Verified: `e2e-smoke` phase 4b clicks select-all, + New group, pastes two
dummy loopback proxies, deletes them via select-all, and adds then removes
an email account — GREEN. Visual check of all three screens on a scratch
API (fake profiles, no real credentials); the email form's Add button was
cut off at narrow widths and fixed. Gates: 661/661 API, 20/20 server, tsc
and build clean.

## Browser timezone follows the proxy (2026-11-17, branch `proxy-timezone`)

Owner testing 7 ISP proxies (Ashburn, VA) found a proxied profile ran on its
fingerprint's default clock (UTC unless pinned) — a contradiction of the
exit IP's location that checkers flag.

- [x] **Timezone follows the proxy's exit IP** (`5634c3e`) — every launch
  picks the browser timezone: profile pin > the proxy's own timezone field >
  the exit IP's timezone looked up through the launch proxy (same geo echo
  as the proxy Test, 8 s budget) > identity default. A failed lookup never
  fails a launch. Per launch only; the snapshot records the identity the
  engine got plus `timezoneSource`, and `/profiles/:id/egress` reports both.
  6 tests.

**Live (scratch API on 50477, fury qp.4, a local recording proxy — the
owner's 7 proxies' passwords live only in the live app's DPAPI store):** a
fresh profile with stored timezone `UTC` opened with the page reporting
`America/Toronto` (GMT-0500), `/egress` `timezoneSource: exit-ip`,
attestation `match`, stored identity still `UTC` afterwards.

**Owner's proxies (69.33.225.30–36), 2026-11-17:** all 7 alive (~86 ms),
static, no IPv4/IPv6/WebRTC/DNS leaks. Physically in Ashburn, VA (28.7 ms
connect, same as AWS us-east-1), but their public records disagree: ARIN
lists the /24 under a private residence in Brampton, ON (ip-api and iphey
follow it), reverse DNS is still `*.sjc.megapath.net` (IP2Location and
ipapi.co say San Jose), ipinfo says Leesburg, VA. Only the provider can fix
those (ARIN record, PTR names, an RFC 8805 geofeed). Re-test on the live
app once this branch is deployed.

Gates: 667/667 API, 20/20 server, tsc and build clean, e2e GREEN.

## v0.16.5 — deviceMemory heap-cap coherence (2026-11-17, `134b8d9`)

AliasMode's full check flagged the proxied LeakTest profile:
"deviceMemory 4 · heap 4.09 GiB". V8 caps its JS heap near 4.09 GiB on any
host with >= 8 GB RAM and page JS can read that limit, so a 4 GB claim is
UNDER what the heap reveals — self-contradicting on every big-RAM machine,
independent of how many browsers run (deviceMemory is a reported value, not
an allocation; browser count is unaffected).

- [x] **Never claim 4 GB on >= 8 GB hosts** (`134b8d9`) — the existing
  host-memory clamp only ruled out claiming MORE than host RAM; extended
  with the heap-cap rule: when host RAM is known and >= 8 GB, drop the 4 GB
  bucket (8 is the smallest Chrome bucket above the cap; 8/16/32 are always
  coherent). Sub-8 GB hosts keep claiming 4, where V8 derives a smaller
  heap. Every new identity now automatically matches whatever machine it
  is generated on — portable across the owner's machines, zero per-profile
  work.
- [x] **Tests** (`134b8d9`) — 8 generator tests, incl. 8/16/32 GB hosts
  never drawing 4. Gates: 667/667 API, tsc, build clean.

**Live verify (scratch API on 50326, fury qp.4, throwaway profile, real
window):** aliasmode.com/check/ read `deviceMemory 8`, heap 4.09 GiB,
hwConcurrency 8 — coherent; the memory finding did not appear. 22 checks,
2 unrelated items below. Throwaway cleaned up.

## Findings from the live leak battery (2026-11-17, recorded, not yet shipped)

Measured on the owner's real setup (fury 0.5.5-qp.4, stock Windows host,
7 ISP proxies added to the live app):

- [ ] **DNS leak through the HTTP proxy (the one "problem" on the proxied
  run)** — page DNS resolved via Cloudflare US resolvers while the proxy
  exits in CA. Almost certainly Chromium Secure DNS (DoH) bypassing the
  proxy. Fix is engine-level (`C:\queuepilot-engine`): policy/patch to
  disable Secure DNS or force DNS through the proxy. Highest impact —
  affects every proxied profile.
- [ ] **Speech voices: only online Google voices, no Microsoft voice** —
  not what stock Windows Chrome shows (it lists local Microsoft voices).
  Our engine build lacks the Windows SAPI speech component. Engine-level
  (component inclusion in the build manifest).
- [x] **No-proxy profiles default to UTC** — FIXED 2026-11-17 (code in this
  commit). aliasmode flagged "Browser runs at UTC+0 but the IP is at UTC-5"
  for any profile without a proxy and no pinned timezone. The launch
  timezone chain now reads: profile pin > proxy's timezone field > exit-IP
  lookup > **host's own timezone when no proxy** (source `host`) > identity
  default. A direct connection's IP is the machine's, so the machine's zone
  is the only coherent answer; fallback to the identity default only when
  the host zone is unreadable. Two new tests; gates 668/668 API, 20/20
  server, tsc, build clean.
- [ ] **One-off zero-outer-geometry window** — one scratch-instance launch
  reported `outerWidth/outerHeight = 0` (aliasmode reads that as headless)
  while a second launch on the same instance and two on the live instance
  were all correct. Not reproducible on retry; watch item — if it recurs,
  capture the launch args + persona config of the affected profile.

Everything else in the battery passed: TLS/JA3 byte-identical to stock
Chrome, H2 clean, WebRTC shows only the proxy IP, UA/CH/language coherent,
automation clean, canvas/audio/fonts/screen agree.
