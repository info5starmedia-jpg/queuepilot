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

## P1.5 — Jancy-parity core (IN PROGRESS — providers DONE v0.3.0, temp proxies v0.4.0)

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
- Next in this track: tab/partition model (related tabs share an isolated
  in-memory session); Google Sheets providers (OAuth).

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
