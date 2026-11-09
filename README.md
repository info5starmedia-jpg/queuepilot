# QueuePilot

**Local-first, API-first antidetect browser profile orchestrator.** MIT licensed.

QueuePilot manages browser profiles — each with its own fingerprint identity, proxy and
cookie jar — and launches real fingerprint-resistant browsers for them. It is built
around the two things that actually break multi-account tooling in production:

1. **Deterministic lifecycle.** A profile can never launch twice (guarded in-process
   *and* by a unique constraint in SQLite), a crash never corrupts profile state, and
   an API restart reconciles the database against real OS processes before serving
   traffic.
2. **A typed, documented API.** Zod contracts shared between server and clients, an
   AdsPower-compatible Local API on port 50325 (existing automation tooling works by
   pointing it at QueuePilot), plus a native REST API and an SSE event stream.

## Status

`v0.3.0` — foundation + Phase 1 (engine trust & launch identity) + profile/proxy
providers. What works today, covered by 61 tests:

- Profiles, groups, tags, notes — full CRUD, fingerprint identities (immutable,
  seed-deterministic, hardware-coherent) generated at creation and regenerable.
- **Edit-while-running**: regenerating a fingerprint or changing the proxy of a
  RUNNING profile is allowed — the live session keeps the identity it launched
  with, and `GET /profiles/:id/drift` reports exactly what "applies at next
  start". The identity of record is the launch snapshot, not the profile row.
- **Launch-identity snapshots** — every run durably records the exact
  identity + proxy + engine it launched with (atomic JSON write per run).
- **Engine installer** — consent-gated (no consent, no download), SHA-256
  pinned, atomic install, idempotent; a checksum mismatch is a hard refusal,
  never a warning.
- Proxies — full CRUD, TCP liveness test, credentials write-only over the API.
- Browser lifecycle — start/stop/active/history, double-launch guard,
  crash detection, idempotent stop, boot-time recovery, lifecycle events (SSE).
- AdsPower-compatible endpoints: `/status`, `/api/v1/browser/start|stop|active`,
  `/api/v1/profile/list|create`.
- Two engine runtimes: **fake** (deterministic, for tests/CI/demos) and
  **camoufox** (real fingerprint-patched Firefox; bring your own binary).
- **Profile providers** — refreshable CSV imports following the familiar
  column spec (`Profile`/`Name`/`Email` required; groups, tab color, address,
  DOB, phone, multiple SMS numbers with country codes, passcodes, Free 1–10,
  per-profile proxies, notes, URL, timezone, favorites, named credit-card
  sets). Refresh upserts by key and never churns identity or run state.
- **Proxy providers** — refreshable delimited files (comma/tab/colon/
  semicolon, optional header, optional timezone column) with
  persist / start-over / random distribution via `POST /proxy-providers/:id/next`.

Not yet: web dashboard, Google Sheets providers, resolver/parser registries,
tab/partition model, plugin system, own Chromium engine build. See
[docs/roadmap.md](docs/roadmap.md) and [docs/build-plan.md](docs/build-plan.md).

## Quickstart

```bash
npm install
npm run dev -w apps/api          # or: npm start
```

The API listens on `http://127.0.0.1:50325` (the AdsPower convention, so existing
scripts work unchanged).

```bash
# create a profile (gets a coherent fingerprint identity automatically)
curl -X POST http://127.0.0.1:50325/profiles \
  -H 'content-type: application/json' -d '{"name":"account-1"}'

# launch its browser (AdsPower-compatible)
curl "http://127.0.0.1:50325/api/v1/browser/start?profile_id=<id>"
# -> {"code":0,"msg":"success","data":{"ws":{"puppeteer":"ws://127.0.0.1:9222/...",
#    "selenium":"ws://..."},"debug_port":"9222"}}

# connect Playwright/Puppeteer to data.ws.puppeteer, automate away

curl -X POST http://127.0.0.1:50325/api/v1/browser/stop \
  -H 'content-type: application/json' -d '{"profile_id":"<id>"}'
```

### Import a profile CSV

```bash
curl -X POST http://127.0.0.1:50325/profile-providers \
  -H 'content-type: application/json' \
  -d '{"name":"my-sheet","sourcePath":"/path/to/profiles.csv"}'
# -> {"provider":{...},"refresh":{"imported":N,"updated":M,"issues":[]}}
# re-read the file later: POST /profile-providers/<id>/refresh
```

### Try it without a browser engine

```bash
SPECTRA_RUNTIME=fake npm start
```

The fake runtime simulates a real engine (pid, debug port, ws endpoint, exit
signals) — the full API and lifecycle work, no browser required.

### Real engine (Camoufox)

Camoufox is a C++-patched Firefox with fingerprint spoofing below the JS layer.
QueuePilot never downloads code silently: install Camoufox yourself and either set
`SPECTRA_CAMOUFOX_PATH` or place the binary at `<dataDir>/engines/camoufox/`.

## Configuration

All config is environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `SPECTRA_PORT` | `50325` | API port |
| `SPECTRA_HOST` | `127.0.0.1` | Bind address (loopback by default, on purpose) |
| `SPECTRA_DATA_DIR` | `~/.queuepilot` | SQLite + profile data |
| `SPECTRA_RUNTIME` | `camoufox` | `camoufox` or `fake` |
| `SPECTRA_API_TOKEN` | unset | If set, every route except `/health` needs `Authorization: Bearer <token>` |

## Development

```bash
npm test          # vitest across workspaces
npm run typecheck # strict TS everywhere
```

Design documents: [docs/architecture.md](docs/architecture.md) and
[docs/adr/](docs/adr/) record the decisions and *why* they were made.

## License and attribution

MIT (see [LICENSE](LICENSE)). QueuePilot is original code. Its architecture draws on
published patterns from the open antidetect ecosystem (contract-driven control
planes, deterministic lifecycle testing, AdsPower's de-facto Local API
convention); no AGPL-licensed code is used.
