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
  eyes on the checker pages, on a fury-core machine. Then: the
  default-engine decision.
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
2026-11-16 with the remaining rows classified as in-build (D-003), owner-approved
deferrals, or plugin-shaped content. The build may ship to family/friends on the
workflow surface; the external checker pass (CreepJS/sannysoft, P4) is the last
verification owed before calling the ENGINE done.

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

## v0.14 — Persona fields / 2FA layer (first item)

See P7 Jancy-gap item 5 above for sub-steps and goal. The v0.14 list is
now complete: WPM typing shipped in item 11, and the profile panel UX
shipped in item 24 on the vanilla console (ADR-0005's React rewrite
remains optional and deferred — revisit only if the console outgrows
vanilla).

## P5.6 — Perf & startup

Folded into the P7 numbered list (item 12) with sub-steps and goal.
