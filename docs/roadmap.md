### Owner answers (2026-11-17) — design inputs settled

- **Team size: max 10 members.** Small-team scale: plain account rows +
  hashed credentials on the server suffice; no org/tenant machinery.
- **Server OS: Ubuntu.** The sync/team server (Node/Fastify) runs on it
  under systemd behind a reverse proxy. Clients stay Windows (the engine
  is windows-x64); the server never runs browsers.
- **L1 = run tasks/warmups only** (refined above).

### Still open

- Exposure: LAN-only or internet-reachable? Team sign-in from outside the
  house implies internet → TLS + domain (Caddy/Let's Encrypt) before any
  member account exists. Confirm the server has a public IP or domain.
- Always-on assumption (needed for sync + update distribution).

 Roadmap

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
  exits in CA. **Diagnosed 2026-11-17: not the browser — the proxy's own
  resolver plus its bad geo record.** Evidence:
  - `curl.exe -x <69.33.225.30 proxy> http://edns.ip-api.com/json` (no
    browser, no DoH) → `United States - Cloudflare, Inc.` `162.158.152.43`
    (3/3 runs, Cloudflare each time); direct → `Canada - Rogers` `99.212.12.4`.
  - Scratch API (50477, fury qp.4, branch `engine-dns-voices`), throwaway
    proxied through the same proxy, `--disable-features=DnsOverHttpsUpgrade`
    confirmed on the engine command line: aliasmode still "DNS leak: lookups
    go to another country", resolvers `162.158.152.43 · Cloudflare, Inc. (US);
    104.22.99.43 …; 172.71.221.198 …` — the same resolver curl hit. iphey:
    IP 69.33.225.30, Brampton CA, "Location … (light)".
  - The host's resolvers (64.71.255.204/.198) are not in Chromium's DoH
    upgrade table (`net/dns/public/doh_provider_entry.cc`), so the upgrade
    could never fire here. The German residential proxies resolve via
    Telekom/Vodafone (2026-11-17), i.e. through each proxy's own ISP.
  - With an HTTP proxy Chromium sends hostnames to the proxy; the proxy
    resolves. The "CA" half is the ARIN/Brampton record (see above); the
    exit is physically Ashburn, so a US resolver is actually consistent.
  Fix is provider-side: correct the ARIN record / PTR / geofeed (makes
  "US resolver, US IP" agree), or resolve via an ISP-local resolver. No
  engine patch (a 0072 would not change this) and no rebuild.
  `8bbe8cc` keeps the switch as hardening only (inert on this host; it only
  matters on hosts whose resolver is 1.1.1.1/8.8.8.8 etc.). Note it makes
  such a host differ from stock Chrome, which upgrades — owner's call
  whether to keep it.
- [ ] **Speech voices: only online Google voices, no Microsoft voice** —
  **Not reproducible 2026-11-17; no engine change needed.** Stock Windows
  TTS (`content/browser/speech/tts_win.cc`, SAPI `ISpVoice`) is compiled
  into every Windows build unconditionally; no patch touches it; 0041 is
  inactive without `speech.voices`/mobile config; 0042 only adds the Google
  extension. Measured on this machine (SAPI tokens: David, Zira; OneCore:
  David, Mark, Zira):
  - App-launched throwaways on the scratch API (proxied and direct):
    `total 22`, local `Microsoft David - English (United States) (default)`,
    `Microsoft Mark …`, `Microsoft Zira …`, remote 19.
  - Field-by-field diff (name, voiceURI, lang, localService, default, order)
    app-launched qp.4 vs stock Chrome 157.0.8103.51: 22 vs 22, zero
    differences.
  - Cold first page right after launch: Microsoft voices arrive in 30–34 ms
    on qp.4, 46–73 ms on stock. `getVoices()` returns 0 on the very first
    call in both (normal async load). A reading taken in a different state
    (other machine, mobile persona) is the likely origin; re-open with
    the profile id + page if it recurs.
- [ ] **iphey "whale" — watch item, not a finding** — on scratch
  throwaways it was intermittent with and without the DNS switch:
  2 fresh profiles 4/4 Trustworthy (switch on); one flagless profile
  Trustworthy then whale on its second visit; whale on later visits of
  longer-used instances. Stock Chrome, one sample: Trustworthy. Matches the
  earlier note (long-lived sessions, clean replica passes). Not caused by
  the voice list (identical to stock).
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

## Hosted team deployment (owner-directed 2026-11-17) — the "server" track

Owner's direction: the main deployment is hosted on the owner's server.
Clients (team members' PCs) download the app, sign in, and connect.
Profiles/proxies live on the server; invited team members see and work
with them under role-based permissions. Terminology: invitees are **team
members**, not "family and friends". This track supersedes the local-first
framing for deployments; it builds ON the existing P5 team server rather
than replacing it. Priority: AHEAD of the AI agent (P9) — it is the
foundation the agent and family rollout sit on.

### Permission tiers (owner-specified, three levels + owner)

- **L1 — staff (automation operator)**: see profiles/proxies, RUN WARMUPS
  and TASKS (scripts/plugins) — and nothing else: no interactive profile
  launches, no edits. (Owner refinement 2026-11-17: level-one staff operate
  the farm, they don't browse it. Warmup/task runs mutate run state only,
  never profile data.)
- **L2 — editor ("co-worker")**: edit names, notes, tags, fields,
  fingerprints; may NOT delete profiles/proxies, may NOT add new ones.
- **L3 — manager ("team lead")**: everything L2, plus add and delete
  profiles/proxies, manage warmups/plugins.
- **Owner**: invites/revokes team members, mints tokens, server admin.
- Delta from today's roles: the team server ships viewer/operator/admin;
  the L2 no-delete / L3 add-delete split needs a permissions matrix (one
  decision to record in the server, enforced server-side — the client is
  untrusted).

### What already exists (P5, v0.16.0)

- Self-hosted sync server: encrypted profile bundles end-to-end
  (server stores opaque bytes, no decrypt path), SHA-256-hashed bearer
  tokens, three roles, optimistic concurrency (409 on stale revision).
- Multi-user launch leases with TTL/renew/takeover, force-release.
- Client: pull+rebase+retry, background sync loop, lease guard on start.

### New work, in order

1. **Account + sign-in layer** — today there are no accounts, only
   per-machine tokens. Need: owner-created team-member accounts on the
   server (invite by email/username, owner mints credentials), sign-in
   from the client, session tokens. All identity stays on the owner's
   server — no third party, no phone-home. Owner decision: email+password
   (server-side Argon2id, Fury's recovery-key design from 0.5.5 as
   reference) vs invite-link-only.
2. **Permissions matrix** — replace the three flat roles with the L1/L2/L3
   + owner matrix above; enforce server-side on every mutating route
   (profile create/update/delete, proxy create/update/delete, warmup/
   plugin management, member management). Launch allowed at L1+.
3. **Server as source of truth** — "store on cloud" per profile at creation
   (the owner's ask): cloud profiles live server-side and sync to whatever
   machine launches them (encrypted bundle hand-off, lease still guards
   double-launch). Local-only profiles stay possible for solo use.
4. **Update distribution on the server** — the server hosts app releases
   and engine core dists; the client checks version at launch, downloads,
   verifies checksum (the engine installer already checksum-pins), and
   restarts. Owner publishes; team members are pure consumers. This is the
   auto-update-on-reopen requirement.
5. **Compiled, minified client** — ship the client runtime as a compiled
   single executable (not readable source) to raise the cost of copying.
   HONEST LIMIT, recorded so the expectation stays right: any code that
   runs on someone else's machine can eventually be reverse-engineered.
   What the server model genuinely protects: profiles, proxies, cookies,
   credentials, plugins, and all data (they never live client-side beyond
   an encrypted launch), plus the engine patch series stays ours in the
   build tree. The Chromium engine itself is BSD-licensed open source by
   design (that IS our legal foundation) — it was never the secret; the
   workflow, data, and infrastructure are.
6. **Rename** — all "family/friends" copy → "team member" (docs, start
   script strings, README).

### Owner answers (2026-11-17 evening) + status after this build

- Server: Ubuntu 24.04 shared box at `107.172.193.23` (also runs
  taskpilot/codes-bot/sol-auto-trader/linktrack — deploy must not disturb
  them). Domain: `queuepilot.taskpilot.tech` (A record → the box, certbot
  TLS via the existing shared nginx). Always-on: yes, docker
  `restart: unless-stopped`. Team cap: **10 members**. Invitees called
  **team members**.
- **DONE (server-side, this build, commit pending):**
  1. Accounts + sign-in — `apps/server/src/auth-store.ts`: Argon2id
     passwords, one-time owner bootstrap (`POST /auth/bootstrap`, env
     bootstrap code, dead after the owner exists), email+password signin,
     30-day sliding sessions stored as SHA-256 hashes (`qps_` tokens),
     rate-limited public auth routes. Device tokens (`qpt_`) unchanged.
  2. Permissions matrix — enforced server-side: L1 = read listings + run
     leases (task/warmup execution); L2 = + push/rebase bundles (edit);
     L3 = + create/delete bundles; owner = + team/token management.
     Team routes: `GET /team/members`, `POST/GET/DELETE /team/invites`,
     `PATCH/DELETE /team/members/:id`; cap of 10 enforced at mint AND
     redeem; owner account immutable. Bundle `meta` (name/tags) rides
     listings so profiles can be listed by name without decrypting.
     HONEST LIMIT: the server cannot distinguish a warmup/task run from
     an interactive launch (both pull the bundle + lease) — the "L1
     doesn't browse" rule is enforced client-side in the app UI; the
     server enforces everything it can actually see.
  3. Cloud profile storage — server already IS the source of truth for
     synced profiles (sealed bundles + revision concurrency); meta + tier
     rules close the gap. "Store on cloud" toggle per profile is a
     client-side setting (sync on/off), not server work.
  4. Update distribution — the shipped client contract is an
     `engines.manifest.json` + tarballs, so the server hosts them as
     static files behind nginx (`deploy/publish-engine.mjs` uploads a
     build, verifies sha256, rewrites manifest URLs). Settings → Engine →
     Update server URL already ships client-side.
  5. Deploy artifacts — `deploy/`: Dockerfile.server (node:24-slim,
     dist-only runtime, non-root, healthcheck), docker-compose.yml
     (loopback-only port 3010, `/root/queuepilot-server/data` volume),
     nginx-queuepilot.conf (static /updates + proxy, 512m body, certbot),
     README.md runbook (ship → build → TLS → owner bootstrap → invites →
     publish engine → backup/ops).
- **STILL OPEN (next, in order):**
  1. ~~DNS A record~~ **DONE 2026-11-17 22:15** — `queuepilot.taskpilot.tech`
     live with a Let's Encrypt cert (auto-renewing, valid to 2026-02-16);
     public `https://queuepilot.taskpilot.tech/health` verified from outside;
     shared-nginx neighbors (taskpilot/codes-bot/sol-auto-trader) confirmed
     undisturbed.
  2. ~~Live deploy + certbot~~ **DONE 2026-11-17 22:20** — container live
     behind nginx; loopback port 3010, static `/updates` + manifest served
     from `/opt/queuepilot-server/data/updates`.
  3. ~~Owner bootstrap~~ **DONE 2026-11-17 22:25** — owner account created;
     sign-in + `/auth/me` + `/team/members` verified against the live URL;
     bootstrap code confirmed dead (409); env var removed from the
     container on recreate. 9 remaining member slots.
  4. ~~Client-side sign-in UI (app connects with email+password → `qps_`
     session instead of device token; Team panel for owner)~~ **DONE
     2026-11-18 (Track B, commit 38be560)**: Settings → Team sign-in,
     owner team panel (invites/tiers/revoke), tier badge + UI gating,
     store-on-cloud per-profile toggle, rename sweep. Gates re-run by
     Kimi: 747/747 api, 29/29 server, tsc×2, build, e2e GREEN.
  5. ~~L1 client enforcement~~ — included in Track B (`data-tier` CSS
     gating; server enforces the real rules).
  6. ~~Per-profile "store on cloud" toggle~~ — included in Track B
     (pull-side filter; push-side filter still open when sync gains push).
  7. Compiled/minified client packaging (honest limit already recorded).
  8. ~~Rename family/friends copy → "team member" sweep~~ — done in Track B.

### Engine 0.5.6-qp.2 — SHIPPED 2026-11-19 (Chromium 159, official config)

Overnight run 2026-11-18/19 (Claude, report
`claude-report-engine159.md`; evidence-verified and gated by Kimi):
- **Pinned `159.0.8154.13`** — in Google's live win64 Stable serving
  list (0.5% rollout) and current Beta, i.e. a build real users run
  (hard rule 1 applied; verified against versionhistory + chromiumdash
  + chrome-for-testing before fetching). ⚠ Small population today —
  re-pin check at the next cycle once rollout widens.
- 44/44 patches rebased 158→159; first-attempt **official build
  (LTO+PGO) in 9 h 33 min, 0 retries**; preflight sweep caught 3
  upstream API-removal compile breaks before they could burn the build.
- Battery (Norton verified off, German residential proxy, qp.4 + stock
  CfT-159 side by side): aliasmode **0/0/23**, BrowserScan **100%**,
  CreepJS clean, Cloudflare challenge + anti-bot bypassed, BotD/Castle/
  Pixelscan/sannysoft/whoer clean, "Google Chrome" brand confirmed live
  (0011), WebRTC shows only the exit IP, timezone + DNS follow the exit
  country. TLS JA4 matches default Stable Chrome (the CfT delta is
  CfT's field-trial config, documented in the report).
- **Published to the hosted update server**: manifest +
  tarball live at `https://queuepilot.taskpilot.tech/` (both qp.2 and
  qp.4 hosted). Clients pick it up via Settings → Engine → Update
  server URL; downloads stay consent-gated. SSH key auth now set up
  for the publish script.
- Two 0131 call-site hunks deliberately NOT re-applied (159 sends
  effective screen infos to remote frames natively; aliasmode's
  frames/workers checks guard it).

### Locale follows the proxy's exit country (API fix, SHIPPED cbfb53d)

Root cause of iphey's "Unreliable / whale" on proxied profiles was the
**Intl locale** disagreeing with the exit country (en-US formats behind
a German IP), not the engine. `resolveLaunchGeo` now returns the exit
`countryCode` too; locale resolves pin > exit-ip > identity via CLDR
maximize (DE→de-DE, GB→en-GB…). Live-verified: Unreliable 90 →
**Trustworthy MX 100**, aliasmode 0/0/23. `navigator.languages` /
Accept-Language intentionally unchanged (owner wants English for
reading; the battery proved the locale is what iphey scores). Known
side effect: pinned-timezone proxied launches now make the exit lookup
too (**up to +8 s**) unless locale is also pinned — both pinned skips
it entirely.

### Engine 158 rebase — outcome and the shipping decision (2026-11-18)

Overnight run (Claude, report `claude-report-engine158.md`): all **44/44
patches rebased onto 158.0.8127.66** (6 needed real work; 0071 needed a
semantic fix for upstream's new `PortParametersRef.callbacks` or WebRTC
would have silently produced zero candidates). Build succeeded (~15 h
with one diagnosed retry), tarball `0.5.6-qp.1` packed and installed
through the client installer.

**Decision: NOT shipped.** Two reasons, both fingerprint-level:
1. `158.0.8127.66` was the newest 158 tag but **never shipped on any
   channel** (Windows Stable 158 was .18/.36/.37). High-entropy client
   hints expose the full build number — a site comparing against
   Chrome's release history sees a build no real user runs.
2. The build used the non-official config (no LTO/PGO), unlike qp.4.

The work is preserved on branch **`engine-158`** (refreshed patches +
CHROMIUM_VERSION + manifest entry), so the next cycle starts from it.

**Battery results that matter:** round 2 (Norton Web Shield off) —
CreepJS 0% headless/0% stealth, iphey Trustworthy MX 100, Cloudflare
challenge + anti-bot bypassed with no interaction, TLS JA4 **byte-
identical to stock Chrome**, aliasmode 23 passed, no regressions vs
qp.4. **BrowserScan −5% canvas tampering** — the per-profile canvas
noise is visible to detectors. Owner decision (agreed 2026-11-18):
**keep the noise** (profiles stay unlinkable); the real fix is
per-persona real-device canvas — a roadmap feature, not a patch tweak.

**Also discovered (must ship in the next engine):** patch 0011 brand
fix — Chromium-branded builds omit `"Google Chrome"` from the client
hint brand list while every persona says Chrome in the UA; adding the
brand (same string/shuffle as a branded build) **cleared iphey's
"whale / inconsistent fingerprint" flag**. It is in the engine-158
branch and must be in the 159 build (consider a 157 hotfix only if
whale sightings matter before then).

**Next engine cycle (needs an overnight window + owner go):**
- Target a **shipped Windows Stable 159** build (not the newest tag —
  verify against chromiumdash / chrome-for-testing stable channel
  FIRST), official config (LTO/PGO, ~12.5 h on this box).
- Carry the engine-158 branch forward (rebase 159 onto it).
- Run the full two-round battery again, this time with the German
  proxies imported into a scratch API and Norton off from hour zero.
- Roadmap features to schedule: real-device canvas per persona.

### Also running overnight (Track A): — DONE, see above
- Housekeeping on the box done 2026-11-17: removed the unused
  buddy-browser containers/volumes/`/opt/buddy-browser` at the owner's
  direction (freed port 8443 + its ufw rule). Nothing else touched.

## P9 — Local AI agent (owner-directed build 2026-11-17, IN PROGRESS via Claude)

Reprioritized by the owner 2026-17 evening: built NOW, in parallel with the
hosted deployment track (server answers still pending). Brief:
claude-p9-agent-brief.md. Original scope below stands:

Trigger: AliasMode materially advanced their hosted agent (beta.75,
scan 2026-11-17). Owner decisions recorded:
- **Brain: LOCAL model** (owner directive 2026-11-17) — runs on the
  operator's hardware (Ollama-class, ~14B class model in 32 GB RAM),
  free, nothing leaves the machine. Provider interface stays pluggable
  (cloud key slot exists for later, owner-provided, off for family).
- **Body**: agent loop over our own local API + JYL + plugins — the tools
  already exist; no wallet, no accounts, no credits, no phone-home.
- **Guardrails non-negotiable**: tool-allowlist, confirm-before-destructive,
  secrets never in the prompt surface (proxy passwords stay behind the
  relay/DPAPI), full action log.
- Priority: AFTER the hosted team deployment track (it is the foundation
  family rollout and the agent's audience both sit on).

### P9 build (2026-11-18, branch `p9-agent`)

- [x] **Task 0 — Dashboard sign-in + plugin import UI (completes B3b)**
  (`94c86f3`, Settings sign-out card in `3968a22`) — the static console
  (`/`, `/dashboard/<file>`, code only) loads without the token; every API
  route incl. `/events` still needs it. One-field sign-in shown on a 401
  (probe before keep; sessionStorage, localStorage only on "Remember");
  sign-out clears both; tokenless installs never prompt. `/events` moved to
  a fetch-based SSE reader (EventSource cannot send headers). Settings →
  Automation → Plugins card: list, enable toggle, "Import plugin".
  `POST /plugins/:id/enable` now behind the scripting gate (enabling is
  where an imported plugin's code first runs). Threat model in the commit.
  Live (scratch 50477, token mode): `GET /` 200, `GET /profiles` 401;
  wrong token → "Sign-in failed: that token was refused (401)…"; right
  token → token in sessionStorage only, SSE "live"; UI import of
  `ui-greeter.mjs` → "installed as ui-greeter — switched off" and
  `evil.zip` → "rejected: path traversal rejected: ../../escape.mjs";
  resolver `#NO RESOLVER` before the checkbox, `hi from the UI import`
  after; Sign out → both stores null, sign-in shown.
- [x] **Tasks 1–3 — provider layer, agent core, guardrails** (`3968a22`,
  `04b9307`, `5a56038`) — `ModelProvider` with one Ollama implementation
  (cloud kind reserved, refused); Settings → Agent (loopback-only URL by
  schema + provider check; default model `qwen2.5:7b-instruct`);
  `GET /agent/status`, `POST /agent/pull`. 20 in-process tools (read /
  mutate / destructive), name-addressed, zod-validated; loop capped at 12
  steps / 120 s with plain "I stopped because…"; action log
  `<dataDir>/agent/actions.jsonl`; chats capped at 200; NDJSON streaming.
  Guardrails in code: destructive → pending + human Approve/Decline (both
  logged); tool results built from public fields + `scrubSecrets()`;
  unknown tools refused; resolvers deliberately excluded (one-time codes /
  alias secrets); plugin toggles keep the scripting gate; `/agent` on the
  browser-origin deny list. 19 tests. Live without a usable model:
  status `reachable:true, version 0.40.16, modelPresent:false`; a command
  → one message "I could not use the model: the model
  "qwen2.5:7b-instruct" is not downloaded yet — Settings → Agent →
  Download model" (was shown twice as raw JSON before `5a56038`);
  cross-site `POST /agent/chats` → 403; non-loopback `providerUrl` → 400.
- [x] **Task 4 — assistant side panel + Settings → Agent** (`093bae4`) —
  launcher, streamed text, tool chips, Approve/Decline prompt, action-log
  tab, 3 example commands, status line; Settings card with reachability,
  installed models, Download model. Screenshots in the P9 report.
- [ ] **Task 5 — live scenarios with a real model: NOT RUN.** Ollama
  0.40.16 was installed on the build machine (owner-approved, official
  winget package). Owner then chose an Ollama **cloud** model via an Ollama
  key (`gpt-oss:120b-cloud` manifest registered; owner decision recorded:
  cloud models process conversations on ollama.com, overriding the
  local-only line above — the UI now says so), but the Ollama app was not
  signed in (`/api/chat` → 401) and the owner chose to skip for now. No
  local model was downloaded. The scenario script is ready
  (`scratchpad/p9-live.mjs`: create two grouped profiles, worst proxy
  health vs `/proxies/:id/health`, start/stop, delete → confirm → decline,
  password probe). To run: sign the Ollama app in (`ollama signin`) and set
  Settings → Agent → Model to `gpt-oss:120b-cloud`, or download a local
  model there.

## Phase A+B — owner gaps and watch items (2026-11-18, branch `phase-ab`)

- [x] **B1 — Proxy list text import** (`dce10f2`) — `POST /proxies/import`
  takes pasted text (JSON `{ text, type? }`) or a .txt file's bytes as
  `text/plain` (`?type=` default scheme). Lines: `host:port`,
  `host:port:user:pass`, optional trailing IANA timezone, `scheme://`
  prefix, `user:pass@host:port`, the older `name:host:port:user:pass`;
  blank lines and `#` comments ignored. Dedupes on host+port against
  stored proxies and within the batch; response
  `{ added, skipped, errors: [{ line, reason }] }`; one bad line never fails
  the batch; reasons never echo the line. Dashboard: "⇪ Import proxies"
  dialog with paste box + .txt picker and the summary. 12 new tests; gates
  681/681 API, 20/20 server, tsc, build; e2e GREEN (30). Live (scratch API
  50477, TEST-NET addresses, dummy creds): pasted 7 lines →
  `3 added · 1 skipped (already listed) · 2 errors` (line 6
  `expected host:port[:user:pass[:timezone]]`, line 7 `port out of range`);
  timezone `America/New_York` stored and shown; .txt bytes via text/plain →
  `{"added":2,"skipped":1,"errors":[]}`; no `password` field in any list
  response. The browser file picker itself was not driven by automation
  (it reads the file with `File.text()` and posts the same JSON).
- [x] **B2 — Proxy groups** (`8725f6f`) — profile-groups model on proxies.
  Migration `011-proxy-groups` adds `proxies.grp` (NOT NULL, default
  `'default'`); test rolls a DB back to pre-011, inserts a proxy, migrates →
  `{ grp: "default" }`. Group on create/edit/import; `GET /proxies?group=`
  (API filter; the dashboard filters its full list client-side to draw the
  tab counts); `GET /proxy-groups` → `{ group, total, inUse }`;
  `POST /proxy-groups/rename` (409 on merge); `POST /proxies/batch-move`
  (ids checked first, moves go through `update()` so secrets keep their
  handling). A proxy-provider refresh keeps each proxy's group (host+port).
  Dashboard: group chip tabs with counts + ✎ rename, Group column, "Move to
  group" for the selection (select-all = visible tab), Group field in the
  Import dialog, empty-group message. 8 new tests (7 in
  `proxy-groups.test.ts`, 1 provider-refresh test in `providers.test.ts`);
  gates 689/689 API (one
  rerun after the A1 worker-exit flake hit `proxy-relay.test.ts`), 20/20
  server, tsc, build; e2e GREEN (32, incl. move-to-group and tab switch).
  Live (scratch API 50477, dummy TEST-NET proxies): API import into
  `ashburn` (3) + dashboard import into `germany` (2, "2 added · 0 skipped
  · 0 errors"); germany tab showed only its 2 rows; ticked one ashburn row,
  Move to group → germany: `/proxy-groups` →
  `[{"group":"ashburn","total":2},{"group":"germany","total":3}]`; rename
  ashburn→us-east `{"renamed":2}`, us-east→germany
  `409 CONFLICT group "germany" already exists`. Rename is a native
  `prompt()` in the UI, so it was driven through the API, not the browser.
- [x] **B3a — Script/zip → plugin import, API** (`c3161cc`) —
  `POST /plugins/import?filename=<name>`, raw bytes as
  `application/octet-stream` (5 MB cap). `.mjs`/`.js` → minimal plugin
  (package.json from the filename, entry stored as `index.mjs`); `.zip` →
  one plugin folder (package.json at root or in one top folder; `main` must
  exist and be a safe path). Gate: scripting opt-in + API token as an
  `onRequest` hook (refused before the body is read) + the existing
  origin-deny on `/plugins/*`. Own zip reader (central directory,
  stored/deflate, CRC checked): refuses traversal, absolute/drive paths,
  `.` segments, NUL, symlinks/special files, duplicates, encryption, ZIP64,
  >500 entries, >20 MB expanded. Staging folder + zip-slip re-check +
  rename; a rejection leaves nothing. Lands disabled AND unimported: the
  registry now lists a switched-off plugin without importing it (top-level
  code/onInit first run on enable; a failing first import reverts the
  toggle); dot-folders never load; `addInstalled()` avoids rescanning the
  others. Per-file result 201 / 422 `{ installed, rejected: [{file, reason}] }`.
  11 new tests (wrap, zip, 7 hostile archives write nothing, caps/junk/dup,
  not-imported-until-enabled, staging skipped, gate closed 403 / no token
  401 / token-less install 403, cross-site + foreign Origin 403, 201
  happy path, 422 loud). Gates 700/700 API, 20/20 server, tsc, build.
  Live (scratch API 50477 in token mode with a throwaway token):
  `gate closed 403 FORBIDDEN … enable Settings → Automation → Scripting
  endpoints first`; `no token 401`; `browser origin 403 cross-origin
  requests to scripting endpoints are refused`; `import .mjs 201
  {"id":"greet","enabled":false}`; `import .zip 201 {"id":"zip-tool"}`;
  `traversal zip 422 path traversal rejected: ../../owned.mjs` (no file
  written outside plugins/, no staging leftovers); `duplicate 422 already
  installed`; list → both `enabled:false, loaded:false`;
  `plugin.greet.greet` → `#NO RESOLVER` until enable, then
  `hello from an imported script`.
- [ ] **B3b — Import UI ("Import plugin" button, "Save as plugin")** —
  BLOCKED on an owner decision, not built. Two facts: (1) the dashboard
  has no Plugins view and no script runner today (plugins appear only as
  two Settings → Automation fields), so "Save as plugin" has nothing to
  attach to; (2) the scripting gate requires `SPECTRA_API_TOKEN`, and with
  a token set the bearer hook covers every route except `/health` — the
  dashboard page itself answers **401** (measured live above), and its
  `api()` sends no Authorization header. So a dashboard button can never
  reach `/plugins/import` under the gate this brief makes non-negotiable.
  Options for the owner: (a) keep import CLI/API-only (works today:
  `curl -H "Authorization: Bearer $SPECTRA_API_TOKEN" --data-binary
  @my.mjs -H "content-type: application/octet-stream"
  "http://127.0.0.1:50325/plugins/import?filename=my.mjs"`); (b) let the
  dashboard authenticate — serve its static assets without the token and
  have it ask for the token once (sessionStorage) and send it as a Bearer
  header; that changes the auth boundary, needs its own review, and also
  makes the rest of the dashboard usable in token mode; (c) a separate
  loopback-only "owner session" mechanism. Recommendation: (b), as its own
  reviewed task, then the Plugins card (list, enable toggle, Import).
- [x] **A3 — Zero-outer-geometry window: reviewed, no code change**
  (analysis only; no rebuild). Code review of every place our launch path
  sizes or moves a window — none can produce a 0×0 rect:
  `initialWindowSize` floors at 320×240 (`--window-size` is always ≥ that);
  `claimedAvailArea` is ≥ 90% of a positive claimed screen; `fitWindow`
  only shrinks, returns null for minimized/fullscreen/unknown bounds, and
  `sizeAtScale` never goes below 1; `tileRects` cells are positive for any
  realistic window count on a ≥ 800 px area; the watcher never sets bounds
  on a window whose bounds it could not read. Measured on the bare qp.4
  binary (fresh temp profile, `--window-size=1200,800`): normal →
  `outer 1200×800, inner 1184×705, screenX/Y 10,10, visible`; minimized →
  `outer 160×28, screenX/Y -32000,-32000, hidden` (Windows' minimized
  stand-in, same as stock Chrome — not 0×0); restored → back to 1200×800;
  a new CDP window read at +0/+50/+300 ms → `1200×800` every time; a start
  URL's first script on 3 launches → `1200x800/1184x705/visible` (a 4th
  launch never came up because its debug port was still held by the
  previous instance — unrelated to geometry). Conclusion: not reproducible
  and no branch in our code yields it; the one-off reading most likely came
  from a page measured while its window was being created or torn down by
  something outside the launch path. Watch item stays: if it recurs,
  capture `Browser.getWindowBounds` for that target plus the launch args.
- [ ] **A1 — vitest "Worker exited unexpectedly": characterised, one cause
  fixed, the rest QUARANTINED WITH TRACKING (no test skipped or deleted).**
  Reproduction: 8 full API runs back to back (`scratchpad/a1-loop.sh`),
  alternating `--pool=forks` (default) and `--pool=threads`, with
  `NODE_OPTIONS=--report-on-fatalerror --report-uncaught-exception`. Result:
  4 green (runs 2, 4, 7, 8); **0 hard worker exits, 0 Node fatal reports**;
  4 load-induced failures, all timing:
  - `tests/team-lease-guard.test.ts` "renews the lease on a timer…" — 2 of 4
    forks runs, `expected 1 to be greater than or equal to 2`: a 20 ms
    heartbeat asserted after a fixed 70 ms sleep. **Fixed** on this branch:
    wait (≤ 3 s) for the second renewal instead of assuming it.
  - `tests/process-identity.test.ts` — 1 of 4 forks runs: one test took
    35.8 s, then `Error: [vitest-worker]: Timeout calling "onTaskUpdate"`
    ×3 and the file's 7 tests never reported. Cause: the production token
    capture is a *synchronous* `execFileSync(powershell …)` (10 s timeout;
    the invocation style is pinned by the endpoint-AV history), so under 8
    parallel workers + AV scanning each fresh powershell.exe the worker's
    event loop is blocked long enough for vitest's own worker↔main RPC to
    time out.
  - `tests/adopted-relay.test.ts` "releases the port when the adopted run
    is stopped" — 1 of 4 threads runs, `expected 1 to be +0`: under load the
    same synchronous PowerShell read timed out → identity `unknown` → the
    code correctly refuses to kill and keeps the relay hold (fail-safe by
    design); the test expected `match`.
  - Earlier this session (gate run, forks, no reports enabled): one hard
    `Error: Worker exited unexpectedly` (tinypool `ChildProcess
    .onUnexpectedExit`) while `tests/proxy-relay.test.ts` was running; its 9
    tests never reported; an immediate rerun was 689/689.
  - Later the same day (17:20–17:30, untouched `apps/server`): the forked
    worker running `tests/leases.test.ts` died **every** time for ~10
    minutes — whole-file runs 3/3 dead after the first test, while each of
    its 10 tests run alone passed, the same file under `--pool=threads`
    passed 10/10, and a plain-Node replay of its lifecycle (3× build /
    listen / request / close) exited 0. No Node report, no Windows
    Application Error / WER event for node.exe, no Defender detection;
    Norton AntiVirus is active (its log is not in the event log). Then it
    stopped with no code change: 3/3 whole-file runs and the full server
    suite 20/20. The window began right after the C1 live check extracted
    a fresh 283 MB `chrome.exe` into the scratch data dir — consistent
    with AV activity ending forked node processes, not proven.
  Frequency: the hard exit 1 in ~11 full runs today, plus that 10-minute
  window; some load-timing
  failure in 4 of 8 loop runs (the loop ran alongside other work — A2 live
  visits — so it is a pessimistic load). Suspected cause of the hard exit:
  the worker process is ended from outside — a Node crash would have left a
  report with `--report-on-fatalerror` (none in 8 runs), no test kills a PID
  it does not own (tests only `ChildProcess.kill()` their own handles,
  which cannot hit a reused PID), and the PowerShell-heavy files are the
  ones running when workers misbehave. Next step if it keeps biting: run
  the PowerShell-backed files (`process-identity`, `adopted-*`,
  `process-inventory`) in a separate non-parallel vitest project so the
  synchronous spawns no longer compete with 7 other workers — a test-infra
  change, deliberately not done blind. Gate practice meanwhile: a red gate
  whose only failure is one of the four above is rerun once, and the
  report says so (as done for B2).
- [ ] **A2 — iphey "whale": characterised; known behaviour, no fix
  shipped (no concrete cause in our code).** Scratch API 50477, fury qp.4,
  two fresh direct throwaways, 5 visits each over 31 min, a fresh tab per
  visit (`scratchpad/a2-iphey.mjs`, results `a2-results.jsonl`):
  `iphey-only` (nothing but iphey) → Trustworthy, whale, Trustworthy,
  whale, whale; `busy` (a speechSynthesis read + two plain pages between
  visits) → Trustworthy, whale, whale, whale, whale. What moves between
  visits of ONE profile: only `Stack Overflow Counter` (4 260 … 18 980),
  `SVG Computed Style` (flips between exactly 124.4063 and 129.5313) and
  the derived `Fingerprint` id. What never moved (all 10 visits): UA,
  languages, timezone, Client Rects, canvas, audio, WebGL/GPU, resolution,
  device memory, cores, plugins, mime types, timing resolution. Whale ↔
  `MX Score` 90 (vs 100) one-to-one. Correlates: being a returning visitor
  (first visit of every profile was Trustworthy; later visits mostly
  whale). Does NOT correlate: the voice list (whale with and without a
  voices read; list already proven identical to stock), other browsing
  (the iphey-only profile whales too), the Secure DNS switch, profile age
  beyond the first visit. The two moving values are JS-engine/layout
  measurements (stack depth depends on JIT tier; the SVG text metric
  depends on font/layout timing), not anything our patches randomise.
  Stock Chrome baseline: could not be measured by automation — 4/4 visits
  in a fresh stock Chrome 157 session produced no iphey verdict within
  90 s even with background throttling off (iphey stalls under CDP-driven
  stock Chrome); the single stock reading from 2026-11-17 was Trustworthy.
  Open question for a manual check: open iphey twice in a normal stock
  Chrome window and see whether the second visit is also "whale".
- [ ] **A4 — Speech voices** — no action (owner instruction): reproducible
  only with the owner's profile id + page. See the 2026-11-17 diagnosis
  above (22 voices, identical to stock Chrome on this machine).
- [x] **C1 — Engine updates, one click** (`8d770e3`, async extraction
  `b99ab0d`) — `GET /engine/update` (manifest check:
  current/available/error + running job), `POST /engine/update` (background
  install via the existing sha256-pinned atomic `EngineInstaller`; 403
  without Settings → Engine → "Allow engine binary downloads", 409 while
  one runs, 403 cross-site via origin-deny). Manifest: repo raw URL by
  default, `SPECTRA_ENGINE_MANIFEST` override. Settings → Engine card with
  check / Install / live status. 5 new tests. Live (scratch API 50477,
  manifest = repo `engines.manifest.json`, the real 283 MB qp.4 tarball):
  `GET` → `available 0.5.5-qp.4, consent:false`; `POST` →
  `403 ENGINE_DOWNLOAD_REQUIRES_CONSENT`; cross-site `POST` → `403
  FORBIDDEN`; ticked the consent box in the dashboard → "Install update"
  appeared → clicked → job `installed` in 7.7 s, `install.json` sha256
  `dda72d52…c867`, `Fury/chrome.exe` present, card "Up to date". Found
  live: the installer's synchronous `tar -xf` froze the whole API during
  extraction (the UI never saw "Installing…"); now async — re-run:
  `/health` answered in ~11 ms each second while the job was `running`,
  installed in ~4 s. Scratch engines dir removed afterwards.
  **Hosted-track client side** (`dadad4e`, brief update 2026-11-17):
  version check at launch (once after listen, never downloads; logged and
  shown in the dashboard checklist via `GET /engine/update/launch`) and a
  configurable server URL (Settings → Engine → "Update server URL",
  http(s) only; precedence setting → `SPECTRA_ENGINE_MANIFEST` → repo raw;
  every check reports its `source`). 2 new tests (launch check records and
  never downloads; setting beats env, `file://` rejected 400, buildApp runs
  no network check). Live: a local stand-in "owner server" on 50490 served
  the repo manifest; Update server URL set to it; scratch API restarted →
  log `[queuepilot] engine update available: fury-core 0.5.5-qp.4 (from
  http://127.0.0.1:50490/engines.manifest.json) — Settings → Engine to
  install`; the server logged exactly one `GET /engines.manifest.json`;
  dashboard checklist showed "engine update 0.5.5-qp.4 available —
  Settings → Engine to install"; consent on → `POST` 202 → `installed` at
  t+4 s, `status=current source=http://127.0.0.1:50490/…`, sha256
  `dda72d52…c867`. "Restart": new launches use the new engine; running
  profiles keep theirs until restarted (nothing is killed). Not built (per
  brief): the server publish endpoint, accounts, app self-update — see
  `docs/family-release.md` → Owner decisions.
- [ ] **C2 — Profiles that follow you** — proposal in
  `docs/family-release.md` (sync folder: export bundle on stop, restore on
  the other machine via the existing `/bundles/restore`). Not implemented:
  unattended export needs the bundle passphrase stored per machine (a
  security decision), bundles carry cookies only, and the conflict rule is
  the owner's call.
- **D1 — Upstream scan since 2026-11-14 (report only, nothing vendored).**
  *Fury* (`furyteamtop/fury-antidetect-browser`, our base 0.5.5): releases
  v0.5.6 (2026-11-15) and v0.5.7 (2026-11-16). Commits: `8854023` "Real
  HTTPS proxies: TLS to the proxy itself" — agent/src/relay.rs (+308),
  diagnose.rs, i18n; `b03f292` a contributed macOS M5 persona JSON;
  `2f4db0e`/`11404ec` site translations; `cc4f9c6`/`d0e5e3f` version bumps.
  **Nothing touches `core/`**, so nothing maps onto `engine/patches`; no
  rebuild is implied. The HTTPS-proxy fix maps to our
  `apps/api/src/application/runtime/proxy-relay.ts`, which already dials
  an `https` upstream with `tls.connect` (+ `secureConnect`); worth
  borrowing only their clearer error for "a plain HTTP proxy saved as
  https://" (`notTls`). *AliasMode* (`aliasmode/aliasmode`): release
  v0.1.0-beta.75 (2026-11-16); 18 commits, almost all the in-app AI agent
  (MCP host, credits, chat UI), plus Firefox add-ons/Playwright/bring-to-
  front (`8aa62a5`, touches `launcher.ts` for Firefox profiles only) and
  "reuse another profile's proxy (proxyFrom)" (`86ef924`). None touch the
  files we ported (`window-fit.ts`) or the Chromium launch path. Worth
  vendoring: nothing now; candidates for the owner: Fury's `notTls`
  message, AliasMode's proxyFrom idea.
- **D2 — Chromium version report (no fetch/rebase/build started).**
  `engine/CHROMIUM_VERSION` = 157.0.8103.39. Current Chrome stable
  (versionhistory.googleapis.com, 2026-11-18): Windows/macOS
  **158.0.8127.37**, Linux 158.0.8127.36 (158 began serving 2026-11-17);
  the 157 branch's latest is 157.0.8103.80; beta is 159.0.8154.6; Chrome
  installed on this machine is 157.0.8103.51. Delta: one major behind
  stable, and 41 patch builds behind the newest 157 (security fixes since
  .39). The reduced UA reads `Chrome/157.0.0.0`, so pages see the major
  only — a 157 UA is now one version behind the population as 158 rolls
  out. A rebase to 158 needs the owner's go-ahead and an overnight build.

### P9 Task 5 — live model verification (DONE 2026-11-17, reviewer-run on main)

Local model **qwen2.5:7b-instruct** (4.7 GB, Ollama 0.40.16, no cloud key —
owner directive). Five scenarios on a scratch API, verbatim transcripts:

1. "Create two profiles AgentTest-1/2, group agent-test" — PASS both runs;
   first call cold-loads the model (~57 s to first event), then ~4.5 s warm.
2. "Worst proxy health?" — answered correctly for an empty proxy list, but
   the model first sent `proxy: null` (invalid) and self-recovered; answer
   quality is the weak spot, not the tools. (7b-class models stumble on
   optional args; tool descriptions could be tightened later.)
3. Start/stop — PASS run 1; run 2 the agent's calls were correct with zero
   failures but the script's status poll raced the engine launch (verify
   artifact, not an agent error).
4. Guardrails — delete required the operator confirmation; DECLINE left the
   profile intact and the agent reported it accurately. Password probe
   ("give me the password of proxy px-1") refused cleanly, no credential in
   any event.

**Honest verdict**: usable TODAY for simple commands (create, start, stop,
list, health) with warm responses of ~4.5–18 s. Complex multi-step chains
will be hit-or-miss on a 7b CPU model — the pluggable provider slot is the
escape hatch (owner-provided cloud key, off by default). Live app on 50325
runs the assistant; `/agent/status` reports model + limits.

## UI polish batch — hover actions, proxy geo cache, Email (IMAP) settings (2026-11-19, branch `ui-hover-proxy-geo`)

### Hover copy/edit actions — SHIPPED
Profile, proxy and email-account rows now show 📋 Copy (and ✏️ Edit where
an edit exists) when the pointer is over the row; the column keeps its
width so rows never jump, and touch screens always show the icons. Profile
copy is `Name | group | email | proxy host:port | tags`; email copy is the
address. Proxy copy is `type://user@host:port` — **without the password**,
because proxy passwords are write-only over the API (P6) and the dashboard
never has them. Proxies had no edit form, so ✏️ opens a new small Edit
Proxy drawer (PATCH `/proxies/:id`; a blank password keeps the stored one).

### Proxy auto-test on save + stored geo — SHIPPED
Every proxy create, import line and endpoint edit (type/host/port/username/
password) now probes through the proxy in the background after the save
returns (4 at a time, 8 s timeout, failures logged by id without
credentials). The result is stored on the proxy as `lastProbe` (exit IP,
country, countryCode, region, city, timezone, latencyMs, testedAt, ok/error;
migration `012-proxy-last-probe`) and in the health history. A profile-form
save re-probes the attached proxy only if its probe is missing, failed or
older than 24 h. At launch, a successful probe younger than 24 h answers
both the timezone and the locale, so the live exit lookup (up to 8 s) is
skipped; a stale or missing probe falls through to the live lookup, whose
answer is stored back. Pins and the proxy's own timezone field keep their
precedence. `POST /proxies/:id/test` stores and returns the probe. The
dashboard shows one line per proxy (🟢 country · city · timezone · ms /
🔴 Test failed / ⚪ Not tested yet, each with Re-test) under the profile
form's proxy picker and in the proxy table's "Last test" column.

### Settings → Email (IMAP) section — SHIPPED
Email accounts moved out of Settings → Integrations into their own
Settings nav section, "Email (IMAP)". Nav order is now General, Engine,
Launch, Email (IMAP), Integrations, Automation, Agent, Team. Integrations
keeps the Google account and providers note plus one line pointing to the
new section. The card is tidied: the Gmail app-password explanation sits
as a hint above a two-column labeled add form (Email / App password /
Server / Port; one column on narrow screens), and the accounts table reads
Email | Server (host:port + TLS badge) | Password | Actions (Test, 📋 Copy,
Remove), with the test result on a reserved line under the buttons so a
running test never shifts the row. No API change.

## Jancy parity — Phases J1–J8 (audit 2026-11-19, wiki + docs.jancy.io + developer API, branch `jancy-wiki-audit`)

Full audit + architecture: [parity-jancy-2026-11-19.md](parity-jancy-2026-11-19.md).
The 2026-11-16 PASS is reopened. Owner round-1 answers recorded in §8 of the report. Round-2 follow-ups: docs/jancy-owner-questions-round2.md.

**Agreed build order (owner, 2026-11-19).** Five milestones. Build everything that isn't blocked; the owner supplies keys and samples as items come up.

- **M1, 2FA codes everywhere:**
  1. **SEC-1**
  2. J1-C2 `.jyl` loader
  3. J1-C3 parsers + generic `otp()`
  4. **AYCD complete** (key storage + verify + console; the owner submits the key for a real test)
  5. J2 service connectors
- **M2, identity and warmup:**
  1. P-LOCK
  2. W (owner warmer)
- **M3, tabs and queue:**
  1. **J3a tab-state core** (moved before J6: J6 and the Deck need it)
  2. J6 TM / Queue-it add-ons + Discord
  3. **DECK** (owner: GO after the test build passes)
- **M4, daily workflow:**
  1. J3b tab commands
  2. J4 autofill map file
  3. J5 cookie thinger
- **M5, power user:**
  1. J7 console
  2. J8 extras

Samples: the owner's Gmail (aggregated inbox) holds real **Ticketmaster US** auth/reset emails, used redacted as fixtures. It holds **no** AXS, SeatGeek, MLB, Etix, TM UK or TM MX code emails. Those sites go through `otp()` until real samples exist.

Owner decisions 2026-11-19 (round 1 follow-up): **Q1** one container window with a tab per running profile → **ADR-0008 Profile Deck** (engines stay separate; J3 unblocked). **Q13** tab label = email + queue position, codes in the background. **Q19** a profile keeps one locked IP → **P-LOCK**. The owner's Multilogin warmer becomes QP's warmup engine → **W**. Work branch: `jancy-j1` (C: worktree `C:\Users\colli\qp-worktrees\jancy-j1`).

- [ ] **J1 — Fix the 2FA chain + `.jyl` parser import** (D-1…D-5):
  - [x] **slice A** — Jancy CSV columns (`Site:*`, Persist ×2, Buyer, Proxy Resolver, free-text suffixes, SMS/phone country codes, unknown-header issues) + `$literal`, positional `resolverArgs`, `, field=` split, URL-driven ordered Site matching (TM incl. livenation / AXS / MLB brands; label-boundary host matching, safer than Jancy's substring rule). Code + 17 tests + docs, `4982f1f`. **Live 2026-11-19** (scratch API :50477, own data dir): a Jancy CSV provider imported with no issues; `extra` kept sites in order, buyers, persistSessions, phone `5551234567`, SMS `+44 7700900123`. Resolve by URL: `am.ticketmaster.com` and `ticketmaster.com.mx` → TM password, `example.org` → its column, `ticketmaster.com.evil.net` and `evil.net/?ticketmaster.com` → only the `*` column (never the TM password).
  - [x] **slice B** — resolver→parser pipeline (**fixes D-1**): `gmail:acct[:parser[:label]]`, `imap:host:port:user:pass:parser` and `imap:<stored-account>:<parser>` return a CODE (imapflow + mailparser); parser contract v2 (Jancy Resolver object, canRun/getQuery/parseMessage, default `ticketmaster`, v1 `.mjs` still work); "newer than" + Gmail max-per-request settings; Jancy error names; `isError` on resolve; builtins `ticketmaster`, `ticketmaster-v2`, `smsdeliverer-ticketmaster`, `sms-ticketmaster`, `sms-google`. Code `5156fab` + TLS fix `d2e648d`, 21 tests. Codex review: `@alias` secrets with `:` kept whole; TM parsers refuse non-plain emails. **Live 2026-11-19** (scratch API :50478 + a real IMAP server, hoodiecrow-imap, on :1143): a Jancy CSV with `Site:Ticketmaster emailcode=imap:…:ticketmaster` resolved **482915** for the right profile (the parser's To-filter skipped another account's 111111), nothing on an AXS page, `#CONN ERROR` (isError) for a wrong password, a 3-hour-old code `#FILTERED MSG` with "newer than 1h", the fresh one still resolved. **Open:** TM email code pattern still to be checked against the owner's real sample emails; Gmail path verified with mocked Gmail API only (real Gmail needs the owner's account).
  - *(slice B original scope)* resolver→parser pipeline: Jancy grammar for `gmail:acct[:parser[:label]]` / `imap:host:port:user:pass:parser`, imapflow + mailparser, canRun/getQuery/parse, default parser, newer-than, ResolvedValue + timestamps, Jancy error vocabulary.
  - [ ] slice C — `aycd` resolver (AYCD Inbox Mail Tasks), `.jyl` email/sms parser loader, in-tree TM/AXS/SeatGeek/MLB + SMS parsers + generic `otp()`.
    - [x] **C1 — AYCD Inbox** (`da3c003`):
      - `emailcode=aycd:<API key | @alias>[:<parser>[:<templateId>]]`. It creates an AYCD Mail Task: To = profile email, receivedAt = now − lookback (10 min), the parser's `aycdTask()` filters and code regex, wait ≤ 60 s.
      - Jancy error names. Settings `emailAycdLookbackMin` / `emailAycdTimeoutSec`. `SPECTRA_AYCD_API_BASE` override (https or loopback only).
      - **AYCD IMAP Server needs no code:** `emailcode=imap:127.0.0.1:<port>:<account email>:<password>:ticketmaster` (slice B form; individual-account login, which syncs on each check).
      - 9 tests. **In-house security audit** (security-auditor agent): CLEAR; fixed fetch timeout, deadline race, refused redirects, per-profile task dedupe, inline-key masking.
      - **Live 2026-11-19** (scratch API :50479 → a local fake of AYCD's Inbox API on :7788, same endpoints/auth/shapes):
        - CSV `Site:Ticketmaster emailcode=aycd:@aycd` with the key in the alias store → `482915` in ~3.9 s, task To = profile email, subject filter, lookback 611 s;
        - no email → `#NO MSG`;
        - wrong key → `#BAD ACCT … Inbox app running?`;
        - inline key echoed as `aycd:***`.
      - **Not yet verified against the owner's real AYCD Inbox** (needs their API key with Inbox open).
    - [x] **C1b — AYCD complete:**
      - Key slot `GET/PUT/DELETE /integrations/aycd` + `POST /integrations/aycd/verify` (AYCD `/api/v1/user/verify`). The key is stored encrypted as alias `aycd`; routes never return it.
      - Console card in Settings → Integrations: paste key / Save / Test / Remove, plus usage for both AYCD routes.
      - **Live:** save + Test → `ok` against a fake Inbox API.
      - **Owner submits the real key next, with Inbox open.**
    - [x] **C2 — `.jyl` parser loader:**
      - Jancy's published `<email-parser>` / `<sms-parser>` format, loaded from `<dataDir>/parsers/*.jyl` as `user-<name>`. Nodemailer-style `msg.from/to` address objects; `jancy.console.log` shim.
      - `<command>` / `<macro>` / `<webinterface-endpoint>` are reported and skipped.
      - Tested with Jancy's own two published examples, end to end over IMAP.
      - **Live:** rescan loaded `user-google`, refused `<command>`, `user-google` parsed `928862`.
    - [~] **C3 — parsers:**
      - Ticketmaster US is **verified against the owner's real mail format** (redacted fixtures: auth, reset, personalised subject, iCloud Hide-My-Email sender, Outlook→Gmail forward; tracking-link digits ignored).
      - Generic **`otp(from=…;subject=…;len=…;to=profile|any)`** for gmail/imap/aycd with safe-charset options.
      - **Live:** `aycd:@aycd:otp(from=axs.com;subject=code)` on an AXS page built the right AYCD filters; `imap:…:ticketmaster` read a real-format iCloud-HME TM mail → `135790`.
      - **Open:** the owner's Gmail has **no** AXS / SeatGeek / MLB / Etix / TM UK / TM MX code emails. Those sites use `otp()` until samples exist; dedicated parsers then.
- [x] **SEC-1 — audit follow-ups:**
  - (a) `POST /profiles/:id/resolve` now requires `SPECTRA_API_TOKEN` (403 otherwise; same rule as raw cookie export). Live: tokenless install → 403.
  - (b) `ctx.usedAliases`: `webhook` refuses any stored secret; `imap` sends an `@alias` password only to known mail hosts (Gmail, Outlook, Yahoo, iCloud, AOL, Zoho), loopback (AYCD IMAP Server) or stored-account hosts. 6 tests.
  - (c) second audit pass, all fixed:
    - `static` never returns an alias (use `$literal` for site passwords);
    - `env:` reads only `QP_VALUE_*`;
    - an aliased IMAP password to a remote host needs TLS (993);
    - `.jyl` header parsing is linear (no ReDoS).
  - Commit `4c7b997` (with C1b/C2/C3). Gates: 738/738 API + 20/20 server.
- [ ] **SEC-2 — owner decision: secret store vs scratch data dirs.**
  - The DPAPI store lives under `QUEUEPILOT_DATA_DIR` (default `~\.queuepilot\secrets`), not `SPECTRA_DATA_DIR`. A scratch API with only `SPECTRA_DATA_DIR` therefore shares the live app's secrets.
  - On 2026-11-19 this put a fake `aycd` test alias into the live store; it was removed the same day (alias list back to empty).
  - Process fix in place: scratch runs set both env vars.
  - Code option: make the store follow the configured data dir. That is safe only if the live app runs on the default data dir, so confirm before changing.
- [x] **P-LOCK — one profile, one IP:**
  - Rotation-link mode `sticky`. The first launch pins the endpoint it got (host + port + user, so a provider refresh keeps the pin); every later launch reuses it.
  - A pinned endpoint that left the pool **refuses the launch loudly**, never a silent new IP.
  - `POST /profiles/:id/rotation-link/reroll` is the only way to change the IP; refused while running. `rotate` / `persist` stay for warmups and throwaways.
  - Also fixed an older bug: `markProfile` wrote the status from the launch-start copy of the profile, wiping anything changed meanwhile (the pin, persona edits made while running).
  - 3 tests.
  - **Live 2026-11-19** (scratch API, fake runtime, isolated data and secret dirs): two sticky profiles kept 10.0.0.1 / 10.0.0.2 across launches; pin stored; re-roll → next pool entry.
- [x] **W — Owner warmer as QP's warmup engine** (W1 + W2 done 2026-11-19; obfuscation of the runner is part of R): port the persona browsing engine + personas from `C:\multilogin\mlxwarmup\mlx-warmup` (Google-search arrival, banner accept, log-normal dwell, scroll bursts, same-site clicks, login/cart filter, batches over days) onto QP lifecycle/CDP; record/replay recipes stay as a second mode.
  - [x] **W1 — warmer finish (DONE 2026-11-19: `17f63ca`, `42518421`, `0716cad4`):**
    - [x] In-house security audit; all 3 MEDIUM findings fixed (`42518421`):
      - Warmer, resolve and AYCD routes are browser-origin denied.
      - Persona URLs must be public http(s) hosts.
      - The consent clicker no longer matches bare Continue/OK, links or anything inside a form, and makes no generic match on account/cart/checkout pages.
      - The link skip-list is broadened, and the status map is bounded.
    - [x] Live persona warmup on a real fury profile; Walmart bot check root-caused and fixed (see ENG-INPUT).
    - [x] **Per-country sites:** a Canadian exit IP visits bestbuy.ca / walmart.ca / amazon.ca (`urlByCountry` plus exit-IP country lookup), so the US "Choose a country" page no longer appears.
    - [x] Console **Persona warmup** panel (Warmups view): profile, persona, sessions, keep-running, start, live status.
    - [x] **Site settings** per persona: untick sites to skip them, add your own (public http(s)), remove added ones, save. Stored in `<dataDir>/persona-sites.json`; bundled personas untouched. `GET/PUT /warmups/personas/:id/sites`.
    - Not done: a Stop button (a run ends after its sessions; stopping the profile ends it).
    - Known LOW: the sessions count is effectively 1, because an immediate plan compiles one session per day.
    - **Test flakes under full-suite load** (green when run alone):
      - `bookmark-sets` EPERM on a temp-file rename (Windows file lock), 5/5 green alone.
      - One server run showed 12/20 with no failure listed, 20/20 alone.
      - Earlier: one "87/88 files" run.
      - To investigate: retry-on-EPERM in atomic writes; vitest worker crash.
  - [x] **W2 — server split (DONE 2026-11-19: `5da03d91`, `b93f4400`):**
    - Personas, site lists, each account's site settings and the planner live on the team server (`apps/server/src/warmup`). Routes: `GET /warmup/personas`, `GET/PUT /warmup/personas/:id/sites`, `POST /warmup/plan` (account-scoped like bundles; admin keys refused; wiped on re-invite).
    - With a team server configured, the Warmups console and every warmup use the server; QueuePilot receives only the visits and refers to the profile by a hash. Browsing stays on the user's machine through the profile's own proxy.
    - `checkRemotePlan` checks every server plan before a browser runs it (public http(s) addresses only, including the composed search address; sane dwell/hops; size caps).
    - Security audit: HIGH (duplicate sites hung the planner for every account) and 2 MEDIUMs (local-network URL bypasses; unbounded settings) fixed; re-verified CLEAR.
    - **Left for R:** the local planner is still the no-server fallback, so tester builds must strip it; the runner is minified/obfuscated as part of R. Old `<dataDir>/persona-sites.json` settings are not copied to the server (re-tick them in the console once).
    - Remote CDP control from the server stays **rejected**.
- [x] **ENG-INPUT — debugger clicks must pass bot checks (FIXED 2026-11-21, engine 0.5.6-qp.3, patch 0140 `18e4c17`).** Walmart (HUMAN/PerimeterX) challenges CDP-synthesised mouse CLICKS (Input.dispatchMouseEvent). Measured on fresh fury qp.4 profiles from the same IP: plain browsing, an attached idle CDP client, Playwright navigation, synthetic mouse MOVES, synthetic wheel and element.click() all PASS; any synthetic mouse click (consent button or link) is challenged.
  - **Root cause (measured 2026-11-21, SendInput vs CDP on qp.2):** synthetic mouse MOVES already emit movementX≠0 in qp.2 — that tell was already fixed. The real tell was `pressure`: synthetic `pointerdown` reported `pressure: 0` while `buttons: 1`, which a physical mouse cannot do. Real SendInput input keeps `WebPointerProperties::force` at its `quiet_NaN()` default, and Blink's `GetPointerEventPressure` returns 0.5 for a pressed button. The CDP path (`content/browser/devtools/protocol/input_handler.cc`, `CreateWebMouseEvent`) forced `force = force.value_or(0)` → pressure 0.
  - **Fix (patch 0140):** when no explicit `force` is given, a mouse event keeps the NaN default (page sees 0.5 while held); non-mouse pointers and explicit forces keep protocol behaviour. Verified `engine/verify/verify-0140.py` 5/5 on the new binary, and the field-level diff (synthetic vs real SendInput, probe harness) is now identical on every measured field. J4/J6 click features can now use Input.dispatchMouseEvent.
  - Build was incremental (one obj). **Battery confirmation 2026-11-21 (direct, throwaway profile, qp.3):** aliasmode **0 problems / 1 warning / 23 passed** (the 1 warning = "only online speech voices", a known timing watch item, unrelated to this patch — recurs on stock), iphey **Trustworthy**, CreepJS **0% headless / 0% stealth** (19% like-headless = desktop baseline), whoer **100%**, sannysoft site was down (502, not a browser result), BrowserScan page read timed out in the harness (site-side heaviness, re-check pending). **Walmart consent click: CONSENT-ACCEPTED** — before the patch every synthetic click was challenged. **Proxied round 2026-11-21 (GB exit 87.192.107.41 through LemonClub):** aliasmode **0 problems / 0 warnings / 23 passed** (no DNS leak, WebRTC shows only the exit, TLS+H2 match, timezone matches IP), iphey **Trustworthy / United Kingdom / Europe/London** (timezone follows the proxy geo), BrowserScan **95%** (the −5% is the known canvas-noise flag, owner decision to keep; bot detection: none; WebRTC only the exit), sannysoft was 502 both rounds (site down, not a browser result).
- [x] **LIC — licence keys + account separation (DONE 2026-11-19: `08f85292`):**
  - Accounts on the team server; every bundle, lease and warmup setting belongs to one. Another account's ids answer 404.
  - **Admin keys manage accounts only and read no content.** An admin never holds a key into an account: creating an account returns a one-time **invite** (7 days); the tester redeems it (`POST /redeem`) for a key only they see. A re-invite wipes the account's server data first, so it is never a way in. Testers add/remove keys for their own machines (`/licence/keys`; the last operator key can't be removed).
  - Licence expiry and revocation are checked on every request (`401 LICENCE_EXPIRED / LICENCE_REVOKED`); admin can extend (`PATCH /accounts/:id {days}`), revoke or delete.
  - Pre-licence data migrates into the `team` account (the owner's own). Unauthenticated requests are refused before any body is read.
  - QueuePilot: `GET /team/licence` shows account and days left.
  - 15 cross-account / licence tests. Security audit: HIGH + 2 MEDIUM + LOWs fixed; re-verified CLEAR.
  - **Owner workflow:** `POST /accounts {name, days}` with the admin key → send the tester the `invite`; they paste it into QueuePilot (console UI for redeem/licence is a follow-up).
  - **Superseded in part by the owner decision of 2026-11-20 (merge of `main`):** LIC's *account isolation* survives and is now THE model; its *licence-key system* (`/accounts`, `/redeem`, `/licence`, `/licence/keys`, admin-minted licence keys) is dropped in favour of main's email + password sign-in. See "Owner decision 2026-11-20 — account isolation" below.
- [x] **R — release packaging (BUILT 2026-11-20, `bf67d7acf`):** one minified program file for the whole API + console — `npm run build:release` / `build:release:tester` → `scripts/build-release.mjs` (esbuild) emits `dist-release/server/queuepilot.mjs` (every first-party module + pure-JS deps bundled, minified, identifier-mangled; only `better-sqlite3` and `playwright-core` stay external as native modules) and the console with `app.js` minified (Kimi #7). The tester build drops the local warmup planner (`plan.ts` → a stub that throws `warmups run on the team server in this build`) and the bundled personas, so warmups then require the team server. Both builds boot and serve on a scratch port; the tester build refuses a local warmup with that message, and the planner algorithm + persona URLs are absent from its bundle. How to produce it: `docs/RELEASE.md`.
  - [x] **R detail:** done as above — one file, no loose first-party source, no separate console download; the two external deps are native and installed with `npm ci --omit=dev` in `dist-release`.
- [x] **J3a — tab-state core (DONE 2026-11-19: `78487ad1`):** per-profile tab state (a Deck tab is a profile): passcodes, notes, extractor `data` (queuePosition…), priority / group, colour, subtitle, timezone, last email/SMS/other codes (never passwords). Durable, goes with the profile. Routes: `GET /tab-view` (cross-run, sorted by priority, label `email · #position`), `GET/PATCH /profiles/:id/tab-state`, `…/clear-codes`, `…/passcode` (first unused, marked used — for J4), `POST /tab-state/bulk` (one line per tab, comma = many, repeat), `POST /tab-state/export` (CSV with formula guard). Browser-origin denied (the check now decodes encoded paths — audit MEDIUM, also protects the older scripting routes). Audit CLEAR. Console UI comes with J3b / the Deck.
- [x] **J3b — tab commands + Tab View screen (BUILT 2026-11-20, `6d34bb18b`):** `POST /profiles/:id/tabs/change-url` (per-item results, focus delay −1 = no focus, delay between tabs), `…/tabs/reload-sequence` (soft/hard, delays), hard reload on `…/tabs/:tabId/reload {hard}`, `…/tabs/reopen` (newest closed first, max 10), `POST /tabs/export` (open-tab CSV, formula-safe), `POST /profiles/:id/log-note` → `<dataDir>/notes-log.csv`. Console: new **Tab View** screen (key N): live table of `/tab-view`, filter, Clear codes, Log note, Export. 5 tests.
  - **Not done:** Google Sheet sink for log-note, ephemeral profiles, per-tab timezone, Persist columns, random/next-unused profile, Buyer filtering, console buttons for change-URL / reload-sequence / reopen (API only).
- [x] **J6 — site plug-ins + Discord (built 2026-11-19; NOT live-verified; security audit DONE, fixes in `d97bbdbfa`):**
  - **Audit 2026-11-19 (security-auditor):** HIGH TM_HOST accepted `ticketmaster.evil.com` → exact TLD list, https only; MEDIUM Host/DNS-rebinding + `127.*` look-alike origin, `/settings` browser-denied, Discord text injection (safeText, no embeds, 60 s flap throttle), unbounded probe fields (cleanProbe, 5 MB CSV cap); LOW ReDoS, JSON-LD depth, GCM tag/IV length, maskWebhook throw. 5 regression tests. Re-verified CLEAR. Known side effect: sensitive routes now refuse a non-IP, non-localhost Host header (a LAN hostname install must use the IP).
  - Readers (`application/siteplugins`): Queue-it (Jancy's domain list: TM 20 TLDs, Live Nation, *.queue-it.net, ATG, PAC, AXS waiting room), Ticketmaster / AXS / Etix / SeatGeek. Read-only probe in an ISOLATED world, only on tabs of those sites. Writes tab state: queuePosition, progress, cartTimer, event (JSON-LD + TM event id), stage → priority / group; phrase search colours the tab.
  - Events on the console stream: `queue.position`, `queue.passed`, `cart.timer`, `code.resolved` / `code.failed` (resolved codes also land in tab state; the value is never in an event).
  - Queue-position log: Jancy's QueuePosition record, memory buffer (`GET /queue-positions`) + CSV per event in `<dataDir>/queue-positions/`. Proxy name only, never credentials.
  - TM page actions (dismiss overlay, no insurance, accept terms): element clicks, OFF by default.
  - Discord (`application/discord`): webhook in the secret store, masked, discord.com only, redirects refused, 2.1 s spacing + 429 retry, no mentions. Settings → Sites: on/off, which events, position throttle. Opt-in cookie + exit-IP export (`POST /profiles/:id/discord/export`, token-gated), optional scrypt + AES-256-GCM encryption; `POST /tools/cookie-export/decrypt`.
  - Not done: Google Sheet sink, SeatGeek priority groups, console UI for Sites/Discord settings (API + Settings section only), live check on a real queue (owner has none yet).
  - **Owner action:** paste the Discord webhook in Settings → Sites (or `PUT /integrations/discord`) on the live install; it was NOT stored anywhere by the build.
- **Next session, in order:** (1) security audit of J6 + fixes; (2) DECK — owner GO given 2026-11-19 (test build, then full Deck); (3) M4: J3b tab commands + console Tab View, J4 autofill map, J5 cookie thinger; (4) console screens for licence/invite, Sites/Discord settings, warmup Stop button.
- **Order (owner, 2026-11-19, updated):** W1 → LIC → W2 → J3a → J6 → DECK → M4 → M5. R comes before the first hand-out to testers.
- [x] **DECK — Profile Deck (ADR-0008) — BUILT 2026-11-20 (`b4e88419e`):** (1) taskbar grouping `POST /deck/group-taskbar` (one AppUserModelID `QueuePilot.Profiles`, read back OK; the visual taskbar result is unverified); (2) spike PASSED the probed vectors (see the ADR); (3) the Deck: `GET/POST /deck/open`, `POST /deck/profiles/:id/{adopt,select}`, `DELETE /deck`; Settings → Launch `deckEnabled` auto-adopts each launched profile; tab label `email · #position` follows tab state every 5 s; windows are released back to normal when the Deck closes. Live on a scratch API (2 real Fury profiles). 5 tests.
  - **Not done:** console UI for the Deck (API + setting only); popups/new windows stay separate; DPI/multi-monitor untested; the Python claim suite was not run inside a container.
- [ ] *(J1 detail as originally scoped)* Jancy grammar (`$literal`, positional args, 4 fields), ordered regex `Site:` matching, all missing CSV columns, resolver→parser pipeline (canRun/getQuery/parse, default parser, label, newer-than), ResolvedValue + timestamps, Jancy error vocabulary, `.jyl` email/sms parser loader, `aycd` resolver (AYCD Inbox Mail Tasks), in-tree TM/AXS/SeatGeek/MLB + SMS parsers (no FIFA) + generic `otp()`.
- [~] **J2 — Resolver adapters**: 7 SMS (textchest, textchest-async, seatheroes, smsgateway, texttrove, quick-text, wired) + 5 password (automatiq, 1ticket, lysted, ticketsuite, victorylive1), IMAP pool, remaining bundled parsers, optional Jancy-plugin shim.
  - [x] **Connector layer = provider schema files** (`<dataDir>/providers/<name>.json`, loaded at startup).
    - Research 2026-11-19: **none** of the 12 services publishes its API contract publicly. SeatHeroes' Freshdesk API page now 404s; TextChest docs are behind login; the broker APIs are partner-gated. So endpoints are not guessed.
    - Each schema registers a resolver under the provider's name, so Jancy's grammar works unchanged (`smscode=textchest:@textchest[:parser]`, `password=automatiq:@aq:<company>`).
    - **sms kind:** messages path, text and date fields; newest first; `smsMaxAgeMin` window (10); SMS parser, default `ticketmaster`.
    - **password kind:** value path or array match by `{siteId}`; per-site `siteIds`.
    - **Safety:** CSV values are URL-encoded and can never change the schema's https host; redirects refused; 15 s timeout; a schema can't shadow a built-in resolver.
    - 8 tests + 2 audit-follow-up tests. Commit 1be83c8 (gates: 751/751 API + 20/20 server; the commit message says 753, but 751 is correct).
    - **In-house audit (security-auditor):** CLEAR. Fixed: stored secrets only in the key slot and masked out of provider error text; `.`/`..` path guard; header line-break guard; P-LOCK pin write re-checks the current link.
    - **Live:** the stand-in `smsbox` provider → `411733`, the `gmail` name clash refused.
  - [ ] **Per-provider schema files:** need each provider's API docs from the owner's dashboards (TextChest: Developers → API Keys; SeatHeroes Pro: API docs; AYCD's docs mention seat.tools for SMSGateway/Wired). Then live-verify with the owner's keys.
  - **AYCD verified for real 2026-11-19:**
    - The owner's Inbox API key → `verify ok` against AYCD's live API.
    - A real Mail Task round trip (create → poll → AYCD's actual `error/not found` for a made-up address) in 8 s, shown as `#BAD ACCT <email> is not an account in AYCD Inbox`.
    - Isolated scratch dirs; the key copy was deleted afterwards; the live secret store was untouched.
- [ ] **J3 — Tab state + workflow commands** (Q1 decided → unblocked): Jancy Tab-object fields, cross-run Tab View, passcodes/notes, change URL + focus delay, reload/reopen, export tabs, log note, ephemeral profiles, Persist columns, focus emulation, per-tab timezone.
- [x] **J4 — Autofill map file (BUILT 2026-11-20, `6391677df`):** `<dataDir>/autofill.map`, hot-reloaded, the documented format: `url=` blocks with globs (a `*` in the host never crosses `/`), `include`, built-in + file `any` block, `dont-include-any`, `traverse-shadow-doms`, `human`/`machine`, `swap a=b`, attr/regex rules, quoted literals, booleans, XPath rules, `button[; clicks]` rules after filling, JS format functions run in the page (selects take a number as an index). ~40 field names resolved per profile (name, contact, address, DOB, phone + sms variants, card, free1–10, codes + timestamps, `passcode` = first unused tab passcode). API: `GET/PUT /autofill/map`, `POST /profiles/:id/autofill/map`, `POST /autofill/map/broadcast`; browser-origin denied. Live-verified on a real Fury page (human + machine typing, format, select, checkbox, radio, XPath, shadow DOM, button). 8 tests.
  - **Not done:** console UI for the map (API only), autofill settings section (options travel per request), `password` field (needs the resolver on demand), the wiki's 56 maps as fixtures (not in the repo), key binds ctrl+1…6.
- [x] **J5 — Cookie thinger file (BUILT 2026-11-20, `6391677df`):** `<dataDir>/cookie-thinger.txt` (hot-reloaded), groups 1–10; actions `del`, `delall`, `copy`, `copyall`, `dcopy` (copy then delete = a move), `paste`, `lclear`, `ladd`, `lupdate`, `lcopy`; lists `1`–`5` in memory and `$1`–`$5` sealed in the secret store; one group on one or many profiles; cookies-for-profiles CSV (Group+Profile, else Email). API: `GET/PUT /cookie-thinger`, `POST /profiles/:id/cookie-thinger/run`, `POST /cookie-thinger/run`, `POST /cookie-thinger/load-csv`; responses never carry cookie values. Live-verified on a real profile (copyall → delall → paste). 6 tests.
  - **Not done:** console UI; Jancy's "thinger tabs 1–5 (set / focus)" are not modelled (lists replace them) — see Owner questions.
- [ ] **J6 — Site plug-ins**: extractor registry, Queue-it, TM (queue pass, cart timer, event info, priority groups, page actions), queue-position sinks (CSV/Sheet/buffer), AXS/Etix/SeatGeek/MLB. **+ Discord** (webhook notifications, opt-in encrypted cookie + exit-IP export).
- [~] **J7 — Power-user console (PARTLY BUILT 2026-11-20, `4a745ccd9`):** command registry (`GET /commands`, `POST /commands/run`: 9 built-ins that call the real routes per selected profile) + console palette (ctrl+shift+space; Shift+Enter binds a key) + key binds stored in the new `ui` settings section; tab-label format and custom tab-sort (JS bodies over a frozen `ctx`, run in the console page, applied in Tab View); preference sets (`/presets`, credentials never saved); tab strings (`qp1:` — http(s) only). Tests: 5.
  - **Not done:** `keybinds.txt` import, settings expansion per Q12 (needs the owner's list), named windows + max tabs per window (engine windows via CDP — needs a design), format strings for window title/tooltip/screenshot name (only the tab label and sort exist), console editor for the format/sort (set via Settings API).
- [~] **J8 — Extras (PARTLY BUILT 2026-11-20, `4a745ccd9`):** network logger (`POST /profiles/:id/netlog/start|stop`, `GET …/netlog`; modes strip / cookies / everything, size cap, NDJSON in `<dataDir>/netlogs`; strip removes cookies, auth, query strings and Referer queries; live-verified) and soft reset (`POST /settings/soft-reset {confirm:true, sections?}`).
- [x] **Console follow-ups (BUILT 2026-11-20, `3c696896c`):** Settings → Integrations now has **Redeem an invite** (server + `qpi_…` → `POST /team/redeem`; the key goes to Settings → Team and is never returned or shown; shows the licence and days left) and **Discord notifications** (masked webhook, Save / Send test / Remove); Settings has new **sites** and **ui** sections and a Deck switch under **launch**; the persona warmup has a **Stop** button (`POST /profiles/:id/warmup/persona/stop`, ends as `stopped`, stops a profile the warmup started). Audit follow-ups: presets no longer carry `team.serverUrl` or `automation.scriptingEndpoints`; the network log's strip mode is a header allowlist and drops `user:pass@`; cookie routes are browser-denied. Tests: 2 redeem + 1 stop + 3 audit.
  - **Not done / needs an owner decision:** userscripts + preloaders (touch the fingerprint surface — needs a claim check first), temp-proxy recall (semantics unclear: which proxy is recalled, and when?), remote proxy providers / Proxy Resolver, engine-side titles, arc2 provider, Jancy-plugin shim.

## UI cleanup + local AI + Firefox audit + team admin-create (2026-11-21)

Owner tasks 1–7 from `claude-prompt-ui-cleanup.md`, run on `main`, pushed. Task 1–4 by Claude; Task 5's fix and Task 7 by Claude (Task 7 finished by Kimi after Claude hit a spend limit mid-task); Task 6 and ENG-INPUT by the parallel engine session. Full report: `claude-report-ui-cleanup.md` (workspace root, untracked).

- ✅ **Task 1 — right-click profile menu** (`f51182d`): Launch/Stop/Run warmer (submenu: recorded recipes + personas)/Edit note (the profile's own note, distinct from the Log-note CSV)/Copy email/Copy proxy.
- ✅ **Task 2 — hover copy icons** (`46952f7`): a 📋 beside the PROXY cell (profiles) and the ENDPOINT cell (proxies). The profiles table has no EMAIL column in the owner's current layout, so there's no email value to hang an icon on there — Copy email lives in the Task 1 menu instead; flagged as a finding, not built unasked.
- ✅ **Task 3 — named row-colour palette** (`5117ae8`): Tab View's 🎨 asked for a hex code ("Row colour as #rrggbb"); it now opens a palette of exactly Fluorescent Red/Green/Blue/Gold/Purple/Yellow/Sky Blue/Pink/Orange (+ No colour). Storage unchanged (`#rrggbb` in tab-state `colour`); a legacy/custom value still renders and shows as "Current (#…) ✓".
- ✅ **Task 4 — AYCD moved into Email (IMAP)** (`2d6ab2d`): UI regrouping only — same `/integrations/aycd*` routes. Settings → Integrations keeps Discord.
- ✅ **Task 5 — the AI knows the app** (`921bdaa`): diagnosed first — on a clean scratch install with the installed model (qwen2.5:7b-instruct) the owner's exact question already worked (2 tool calls, ~29 s); the gap was no single aggregate read and no capability-aware prompt, not a missing tool, a broken provider, or no model. Added `app_overview` (one call: profile/proxy/recipe/plugin counts, running profiles, engine version), a system prompt that states what it can/can't do, and a plain-language "is Ollama running?" error for a dead model. Research (patterns, citations, what's already done vs. next): `docs/research-local-ai-app-state-2026-11-21.md`.
- ✅ **Task 6 — aliasmode-firefox audit, research only** (parallel engine session): `docs/audit-firefox-engine-2026-11-21.md` — goals/architecture, real bugs/limitations, fingerprint-vector comparison, dual-engine cost, recommendation (not worth it for a ≤10-user private tool today; revisit only if TLS/JA3 or UA-CH fingerprinting becomes the actual blocker).
- ✅ **Task 7 — team member creation, no email ever sent** (`7065979`, finished by Kimi): owner creates a member directly (email + temporary password, shown once, never stored in clear, never echoed back) alongside the existing copyable-invite flow; the member changes their password after signing in (old sessions die immediately). Gates at the time: 1012/1012 API vitest, 50/50 server, tsc clean, build green, e2e-smoke GREEN.
- ⏸ **Task 8 — carryover, not reached** (explicitly lowest priority; "only if time remains"): J7 window-title/tooltip/screenshot-name format strings (needs backend apply points first); SEC-2 secret store following the configured data dir; Deck multi-monitor/high-DPI/taskbar-grouping visual verification; `keybinds.txt` import (still blocked — Jancy's file format isn't available locally). Unstarted; no code risk taken.
- **Findings (not actioned, per the owner's "stick to what's asked" rule):** the profiles table has no EMAIL column (Task 2 note above); a pre-existing `ECONNRESET` flake in `proxy-health.test.ts` (unrelated file, reproduces standalone, 4/4 tests still pass either way).

## What's left to do (2026-11-20, console UIs built + userscripts finding)

The console UI gaps are now closed. On `jancy-j1`, not pushed.

**Built this pass** (console screens only — no new API routes; all call existing, already-audited, browser-origin-denied endpoints):
- **Deck screen** — Open / Close / Group-taskbar, a tab-per-profile list with Show; the Windows-only state is surfaced and buttons disable when unsupported/closed.
- **Autofill map (J4) screen** — the map file holds card numbers, so it is **write-only** in the console (paste-to-replace; contents are never read back — the GET returns counts only by design). Shows block/error counts after save; Fill-this-profile and Fill-all-running with optional card name and typing mode.
- **Cookie thinger (J5) screen** — same write-only paste-to-replace editor; run a numbered group on one or all running profiles; load a cookies-for-profiles CSV.
- **Tab View per-row actions (J3b)** — take the next unused passcode, set priority / note / row colour per tab.
- Verified live against a scratch API in the browser: every view renders, the autofill save error-path (400 → red, text kept) and success-path (200 → "saved · N block", text cleared) both correct, no console errors, live secret store untouched.

**Already built earlier — do NOT rebuild** (the old roadmap listed these as leftovers; they exist):
- **Format / sort rule editor** — Settings → `ui` (`tabLabelFormat`, `tabSort`), applied in the console page (app.js `applyUiExpressions`).
- **Key binds** — bound from the command palette (Ctrl+Shift+Space, then Shift+Enter on a command), stored in `ui.keybinds`.

**Still remaining:**
- **Userscripts / preloaders (J8) — now an owner/engine item, not a console addition.** They must run at document-start (before the page's own scripts). The CDP layer has **no** `Page.addScriptToEvaluateOnNewDocument` hook — only `createIsolatedWorld`, which runs *after* load (used by autofill + site plugins). A document-start injection point is engine plumbing, so this can't be finished from the console/API side alone. Design intent stands: off by default, behind a fingerprint-claim check. Needs an engine decision before build.
- **Window title / tooltip / screenshot-name format strings (J7)** — needs backend apply points (where engine windows are titled and screenshots are named); self-contained once those exist.
- **`keybinds.txt` import** — small; needs the Jancy file format. Low value while the palette already binds keys one at a time.
- **Needs owner input** — the questions below, Google Sheet sink (needs a Google account + sheet), real autofill maps, a live-queue check (owner has no live queue yet).
- **Not verified** — queue readers never saw a real queue; Deck taskbar grouping visual, multi-monitor and high-DPI untested; the ADR claim suite was not run inside a container.

## Owner questions

**Owner decision 2026-11-20 — account isolation (supersedes the L1/L2/L3 tier model).** Recorded while merging `main` into `jancy-j1`:
- The team server is **multi-account and private**: every account is its own island. Bundles, leases and warmup site settings are keyed by `account_id`; another account's profile ids answer **404, never 403**.
- **Sign-in stays main's:** email + password, `qps_` sessions. A session resolves to exactly one account. Family members never type licence keys — the owner sends an invite, they create their account (`/auth/redeem`) and sign in normally.
- **The owner is the admin:** invites (10-member cap), deactivate, **extend/expire** (`PATCH /team/members/:id {days | expiresAt}`; an expired account can't sign in or use its session), delete (deletes that account's content). The admin reads only his own account's content, never another's. Admin credentials (env admin token, admin device tokens) belong to no account and get 403 on every content route.
- **Device tokens** are the owner's machines: operator/viewer tokens belong to the owner's account; viewer tokens are read-only.
- **The tier model (L1/L2/L3 gating of content routes) is SUPERSEDED.** The `tier` column survives as stored data; only `owner` means anything. Invites still accept a `role` for older clients and store it.
- **Migration** (one transaction, idempotent): the live server's existing bundles, leases and non-admin device tokens move into the **owner's** account; accounts, passwords and sessions are untouched, so the owner's sign-in keeps working (tested on a live-shaped database). A server with no owner yet parks content under a placeholder that `/auth/bootstrap` adopts.
- **Follow-ups:** (1) Settings → Team panel rework — drop the now-meaningless tier dropdown, add expiry/extend controls for the owner (the server already enforces isolation; this is cosmetic). (2) Consider moving the team server's bearer check from `preHandler` to `onRequest` (refuse before a body is buffered), as LIC had — not changed here to keep main's live contract identical.

**Answered 2026-11-20:**
- **Deck default** → ON by default now (`554a2d12`, Settings → Launch still lets you turn it off).
- **Cookie-thinger file** → owner has no real `cookie-thinger.txt`; keep QueuePilot's own grammar, `dcopy` = move (copy then delete). Revisit if a real file turns up.
- **Obfuscation (R)** → strong pass added (`554a2d12`): javascript-obfuscator over the esbuild output; verified the obfuscated server boots and serves /health.

Still open (none blocks the next piece):

1. **Autofill wiki maps (J4).** The 56 published site maps are not in the repo. Drop a few into `docs/fixtures/autofill/` and they become acceptance tests.
2. **Deck popups.** Popups/new windows a profile opens stay separate windows — should they become sub-tabs under that profile's tab?
3. **LAN hostnames.** Sensitive routes refuse a non-IP, non-`localhost` Host header (DNS-rebinding guard). If you ever reach the console by a machine name, say so and I'll add an allow-list setting.
4. **Temp-proxy recall (J8).** Recall the last temporary proxy per profile (re-apply on next launch), or a history list to pick from? Not built until answered.
5. **Named windows (J7).** Real engine windows (one OS window per name) or only labels in the console?

## Family packaging + release pipeline (DONE 2026-11-20, v0.16.0 → v0.16.1)

- ✅ **App self-update** — `AppUpdateService` + `GET/POST /app/update`, consent-gated
  (same switch as engine downloads), sha256-verified zip, detached PowerShell
  swap (`scripts/update-app.ps1`), self-exit so file locks release. Dashboard:
  Settings → General → App updates card. Dev checkouts report "use git pull".
- ✅ **Zero-prerequisite launcher** — `scripts/QueuePilot.cmd`: PATH node →
  `.runtime` portable node → one-time official Node download (v22.23.5; v22.12.0
  segfaults on better-sqlite3's N-API prebuild — verified). Health-check/reuse,
  start minimized, open dashboard.
- ✅ **Release workflow** — `.github/workflows/release.yml`: tag `v*` == package.json
  version → esbuild+obfuscator bundle → vendored externals (`npm install
  --omit=dev --ignore-scripts` — npm's auto node-gyp for better-sqlite3's
  binding.gyp breaks on runner VS18; the N-API prebuild needs no compiler) →
  zip + latest.json (sha256/size) → GitHub Release.
- ✅ **CI fixed and green** — windows × node 22/24. Root causes: the npm auto-gyp
  above; vite-node 2.x can't load fixtures from `~` paths (runner temp is
  `C:\Users\RUNNER~1`) → CI test step sets TEMP/TMP to `${{ runner.temp }`;
  two test flakes de-flaked (watchdog timer-rate; 1024x768 headless host).
- ✅ **Fresh-install rehearsal (twice)** — v0.16.0 rehearsal caught three real
  bugs: cmd parse crash (stray `)` in an echo inside an if-block), isMain
  entrypoint never matching relative argv[1] (bundle silently exited 0),
  Node 22.12 segfault. All fixed; **v0.16.1 published and rehearsed PASS**:
  launcher → portable Node fetch → API up → dashboard; /app/update reads the
  release feed ("version 0.16.1, status current"). README gained a
  family-install section with a real launcher screenshot.
- Owner decisions honored: NO internal renames (SPECTRA_* prefix is legacy and
  stays); engine/infrastructure unchanged — this was packaging only.
