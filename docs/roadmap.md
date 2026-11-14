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
- a. CreepJS + sannysoft/synthetic surfaces against OUR binary through a
    proxy profile.
- b. Record scores in docs/parity.md next to our claim suite.
- c. Fix anything red; re-run until clean or documented-accepted.
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
- a. Server package (`apps/server`): bundle push/pull, auth tokens.
- b. Roles: admin/operator/viewer; per-profile leases.
- c. Client sync loop + conflict policy (machine-bound secrets never sync).
- d. Multi-machine test: two API instances against one server.
Goal check: profile created on machine A appears on machine B, secrets
intact, lease prevents double-start.

### 8. D-002 / D-003 hardening
Goal: recovery proves process identity, not just liveness; rotation links
designed.
Sub-steps:
- a. D-002: capture process start tokens at launch (Windows creation time),
    store in run record, verify on recovery; test with PID-reuse simulation.
- b. D-003: design doc for proxy rotation links (per-launch endpoint
    refresh); ADR if it changes the proxy model.
Goal check: D-002 test green; D-003 ADR merged.

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

### 12. P5.6 Perf & startup
Goal: cold start < 2.5 s on this machine; no profile-dir staleness after
hard kills.
Sub-steps:
- a. Measure launch → first page on the official build, record in docs.
- b. Hygiene audit: DevToolsActivePort, Singleton* locks after kill -9;
    fix whatever leaks.
Goal check: numbers committed.

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
4. 🟡 **JYL capability adoption** (2026-11-14, 74d46e6) — user commands +
   macros as `.mjs` modules with ctx {args, profileId, log, store, fetch};
   `/jyl/run` API. Remaining: JYL web endpoints + settings bundles.

## P5.6 — Perf & startup

Folded into the P7 numbered list (item 12) with sub-steps and goal.
