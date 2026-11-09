# Roadmap

## P1 — Engine distribution & launch identity (DONE v0.2.0)
- Checksummed, consent-gated engine installer (`EngineInstaller`): SHA-256
  pinned, atomic install, idempotent, mismatch = hard refusal. ✅
- Launch-identity snapshots: every run freezes its identity/proxy/engine;
  edit-while-running allowed; `GET /profiles/:id/drift` = "applies at next
  start". ✅
- Next in this track: engine health probe endpoint (version, launch
  self-test); CLI `queuepilot engine install` wrapping the installer.

## P1.5 — Jancy-parity core (IN PROGRESS — providers DONE v0.3.0)
- Profile providers: CSV import with the full optional-column spec (groups,
  tab color, address, DOB, phone, SMS numbers incl. country codes, passcodes,
  free columns, per-profile proxy list, notes, URL, timezone, credit-card
  sets), refreshable upserts that never churn identity or run state. ✅
- Proxy providers: delimited files (comma/tab/colon/semicolon), optional
  header, timezone column, persist/start-over/random distribution via
  `POST /proxy-providers/:id/next`, refresh replaces the pool but refuses
  while any of its proxies are attached. ✅
- Next in this track: per-tab temp proxies; tab/partition model (related tabs
  share an isolated in-memory session); Google Sheets providers (OAuth).

## P2 — Web dashboard
- React console served by the API itself: profiles grid, proxy manager,
  live status over the existing SSE stream. No separate hosting.

## P3 — Automation depth
- Playwright/Puppeteer connection helpers returned by start (library mode).
- Script runner (user JS/Python against a profile), warmup recorder.

## P4 — Own engine track
- Evaluate a Chromium fork with a quilt patch series (navigator, canvas,
  WebGL, WebRTC, fonts), each patch paired with a runtime verification
  script in `core/verify/`, run in CI against public checkers
  (CreepJS, sannysoft, pixelscan-class surfaces). Detection regression blocks
  release, exactly like a failing test.

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
