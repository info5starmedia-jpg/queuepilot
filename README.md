# QueuePilot

**Local-first, API-first antidetect browser profile orchestrator.** MIT licensed.

QueuePilot manages browser profiles — each with its own fingerprint identity, proxy and
cookie jar — and launches real fingerprint-resistant browsers for them. It is built
around the two things that actually break multi-account tooling in production:

1. **Deterministic lifecycle.** A profile can never launch twice (guarded in-process
   _and_ by a unique constraint in SQLite), a crash never corrupts profile state, and
   an API restart reconciles the database against real OS processes before serving
   traffic.
2. **A typed, documented API.** Zod contracts shared between server and clients, an
   AdsPower-compatible Local API on port 50325 (existing automation tooling works by
   pointing it at QueuePilot), plus a native REST API and an SSE event stream.

**Reading order for anyone picking this up (human or LLM):**
[docs/handoff.md](docs/handoff.md) (the contract — mission, invariants, verified
facts, next tasks) → [docs/parity.md](docs/parity.md) (the completeness checklist
vs Fury/AliasMode, with green gates) → [docs/roadmap.md](docs/roadmap.md) →
[docs/adr/](docs/adr/). The engine patchset is owned in [engine/](engine/).

## Status

`v0.11.0` — foundation + Phase 1 (engine trust & launch identity) + profile/proxy
providers (CSV _and_ Google Sheets) + temporary proxies + engine pre-flight +
tab/partition model with engine-side routing + web dashboard + dual engines
(camoufox / fury-core) + fingerprint attestation + detection claim suite.
What works today, covered by 138 tests:

- Profiles, groups, tags, notes — full CRUD, fingerprint identities (immutable,
  seed-deterministic, hardware-coherent) generated at creation and regenerable.
- **Edit-while-running**: regenerating a fingerprint or changing the proxy of a
  RUNNING profile is allowed — the live session keeps the identity it launched
  with, and `GET /profiles/:id/drift` reports exactly what "applies at next
  start". The identity of record is the launch snapshot, not the profile row.
- **Launch-identity snapshots** — every run durably records the exact
  identity + proxy + engine it launched with (atomic JSON write per run),
  including proxy provenance (`profile` / `temporary` / `none`).
- **Temporary proxies** — pass a one-shot proxy at launch
  (`POST /profiles/:id/start` with a `tempProxy` body). It applies to that run
  only, is never persisted, and the profile's own proxy applies again at the
  next start; drift tells you while it's live.
- **Engine installer** — consent-gated (no consent, no download), SHA-256
  pinned, atomic install, idempotent; a checksum mismatch is a hard refusal,
  never a warning. CLI: `npm start -- engine install --manifest m.json --yes`.
- **Engine pre-flight** — `GET /engine/health` reports the active runtime,
  whether the engine binary is actually on disk, and every verified install
  receipt; `POST /engine/self-test` launches and cleanly stops a throwaway
  browser to prove the full spawn path works.
- **Tabs & session partitions** — open tabs inside a run
  (`POST /profiles/:id/tabs`); every tab lives in an isolated in-memory
  session partition, and tabs opened with `relatedTo` share the parent tab's
  partition (the related-tabs model). Isolation is real on real engines too:
  each partition maps to a CDP browser context (`Target.createBrowserContext`)
  on camoufox — an engine that can't do that answers `TABS_UNSUPPORTED`
  instead of silently sharing a session. Tab state is never written to disk
  and dies with the run; `tab.opened`/`tab.closed` ride the SSE stream.
- Proxies — full CRUD, TCP liveness test, credentials write-only over the API.
- Browser lifecycle — start/stop/active/history, double-launch guard,
  crash detection, idempotent stop, boot-time recovery, lifecycle events (SSE).
- AdsPower-compatible endpoints: `/status`, `/api/v1/browser/start|stop|active`,
  `/api/v1/profile/list|create`.
- **Web dashboard** — zero-build console served by the API itself at `/`:
  profiles grid (start/stop, fingerprint regen, drift badges, tab counts),
  proxy manager with liveness tests, live lifecycle feed over SSE. No separate
  hosting, no CDN, works offline on loopback.
- Two engine runtimes behind the same API: **camoufox** (C++-patched
  Firefox; bring your own binary) and **fury** (Fury's BSD-3-Clause patched
  Chromium core, installed via the checksummed installer), plus **fake**
  (deterministic, for tests/CI/demos).
- **Profile providers** — refreshable CSV imports following the familiar
  column spec (`Profile`/`Name`/`Email` required; groups, tab color, address,
  DOB, phone, multiple SMS numbers with country codes, passcodes, Free 1–10,
  per-profile proxies, notes, URL, timezone, favorites, named credit-card
  sets), **or the same columns straight from a Google Sheet**. Refresh upserts
  by key and never churns identity or run state.
- **Proxy providers** — refreshable delimited files (comma/tab/colon/
  semicolon, optional header, optional timezone column) **or a Google Sheet**
  with the same columns, persist / start-over / random distribution via
  `POST /proxy-providers/:id/next`.

Not yet: resolver/parser registries, plugin system, warmup recorder,
external checker sweeps (CreepJS/sannysoft — deliberately manual), team
mode. See
[docs/roadmap.md](docs/roadmap.md) and [docs/build-plan.md](docs/build-plan.md).

## Quickstart

```bash
npm install
npm run dev -w apps/api          # or: npm start
```

The API listens on `http://127.0.0.1:50325` (the AdsPower convention, so existing
scripts work unchanged). Open `http://127.0.0.1:50325/` in a browser for the
dashboard.

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

### Launch with a temporary proxy

A one-shot proxy for a single run — never persisted, dies with the run:

```bash
curl -X POST http://127.0.0.1:50325/profiles/<id>/start \
  -H 'content-type: application/json' \
  -d '{"tempProxy":{"type":"socks5","host":"10.0.0.9","port":1080,"username":"u","password":"p"}}'
# GET /profiles/<id>/drift will say: running on a temporary proxy —
# the profile's proxy applies at next start
```

### Engine pre-flight

```bash
curl http://127.0.0.1:50325/engine/health        # runtime, binary presence, install receipts
curl -X POST http://127.0.0.1:50325/engine/self-test   # launch + stop a throwaway browser
```

### Install an engine from a manifest

```bash
npm start -- engine install --manifest engines.json --yes
# without --yes: prints the entry and refuses — no bytes move
```

### Engines: camoufox (default) and fury-core

Two engine runtimes ship behind the same API:

- `camoufox` — C++-patched Firefox (default; `SPECTRA_CAMOUFOX_PATH` or
  `<dataDir>/engines/camoufox/`).
- `fury` — Fury's BSD-3-Clause patched Chromium core (Chrome 157):
  C++-level canvas/audio/WebGL/WebGPU/font/timezone spoofing. Install the
  pinned, checksum-verified build and select it:

```bash
npm start -- engine install --manifest engines.manifest.json --yes
SPECTRA_RUNTIME=fury npm start
```

Persona config is handed to the core as an inherited file handle (never in
argv); `GET /profiles/:id/attest` verifies what actually materialized.

Proxies on fury go through an auth-injecting loopback relay
(Chromium strips credentials from `--proxy-server`, so the relay injects
`Proxy-Authorization` itself and fails closed). http/https upstreams today;
socks5 is refused loudly with `PROXY_UNSUPPORTED`, never silently bypassed.

**The patchset is ours.** Fury's BSD-licensed patch series and build chain
are vendored in [`engine/`](engine/) — we can rebase, extend and build our
own Chromium (ritual in `engine/README.md`); the prebuilt upstream binary
remains the default runtime until our own build passes the same gates.

### Detection claim verification

Beyond per-profile attestation, a claim suite states what must be true about
ANY page the engine touches — webdriver hidden, UA stock-shaped, UA-CH
brands consistent, `window.chrome` stock surface, no automation traces,
plugins present, permissions coherent, worker/main-world agreement, canvas
determinism, WebGL coherence — plus persona-bound expectations (platform,
cores, screen, timezone, locale). Claims are calibrated against stock Chrome
ground truth, not detector folklore:

```bash
# engine resolution: SPECTRA_FURY_PATH, else newest verified install under <dataDir>/engines/fury-core/
npm run verify --workspace apps/api -- --engine fury --data-dir <your-data-dir>
npm run verify --workspace apps/api -- --engine fury --proxy --data-dir <your-data-dir>  # + egress-via-proxy proof
npm run verify:calibrate --workspace apps/api                 # probe stock Chrome as baseline
```

Live results on fury-core (Chrome 157): 16/16 claims hold direct; 16/17 hold
with `--proxy` (`uach-consistent` honestly skipped — a LAN-HTTP page is not a
secure context; `egress-via-proxy` PASS). External checkers
(CreepJS/sannysoft) stay a deliberate manual pass — a gate must never depend
on a third-party site's mood.

### Fingerprint attestation

The launch snapshot records what we ASKED the engine for; attestation probes a
live page over CDP and reports what the engine ACTUALLY materialized:

```bash
curl http://127.0.0.1:50325/profiles/<id>/attest
# -> {"verdict":"match","observed":{...},"differences":[],...}
# verdict: "match" | "mismatch" (per-field differences listed)
#        | "unattested" (run has no identity of record)
```

### Run a script against a profile

User automation as a JS module — the runner borrows the live session (starts
the browser if needed, never stops it):

```js
// my-script.mjs
export default async ({ api, wsEndpoint }) => {
  // puppeteer.connect({ browserWSEndpoint: wsEndpoint })
  // playwright: chromium.connectOverCDP(wsEndpoint)
  return { title: "done" }; // printed to stdout
};
```

```bash
npm start -- script my-script.mjs --profile <id>
```

The typed SDK (`@queuepilot/client`, a zero-dependency fetch wrapper over the
whole API) is what `ctx.api` hands to scripts — same types as the contracts.

### Tabs and session partitions

Tabs live inside a run. Every tab gets its own isolated in-memory session
partition unless you open it as _related_ to another tab — related tabs share
the parent's session (cookies/storage), everything else is isolated:

```bash
# isolated tab
curl -X POST http://127.0.0.1:50325/profiles/<id>/tabs \
  -H 'content-type: application/json' -d '{"url":"https://example.com"}'

# related tab — shares the parent tab's session partition
curl -X POST http://127.0.0.1:50325/profiles/<id>/tabs \
  -H 'content-type: application/json' -d '{"url":"https://example.com/cart","relatedTo":"<tab-id>"}'

curl http://127.0.0.1:50325/profiles/<id>/tabs                 # tabs + partitions
curl -X POST http://127.0.0.1:50325/profiles/<id>/tabs/<tab-id>/close
```

Tab state is never written to disk and dies with the run. A runtime that
cannot manage tabs answers `501 TABS_UNSUPPORTED` rather than pretending.

### Import a profile CSV

```bash
curl -X POST http://127.0.0.1:50325/profile-providers \
  -H 'content-type: application/json' \
  -d '{"name":"my-sheet","sourcePath":"/path/to/profiles.csv"}'
# -> {"provider":{...},"refresh":{"imported":N,"updated":M,"issues":[]}}
# re-read the file later: POST /profile-providers/<id>/refresh
```

### Import from Google Sheets

Set `SPECTRA_GOOGLE_CLIENT_ID` / `SPECTRA_GOOGLE_CLIENT_SECRET` (a Google Cloud
project with the Sheets API enabled), then connect once:

```bash
curl http://127.0.0.1:50325/google/auth/url     # open the returned URL in your browser
# after consent, Google redirects back and the token is stored under <dataDir>/google/
curl http://127.0.0.1:50325/google/auth/status  # {"configured":true,"connected":true,...}

# same column spec as CSV, straight from a sheet
curl -X POST http://127.0.0.1:50325/profile-providers \
  -H 'content-type: application/json' \
  -d '{"name":"my-sheet","sheetId":"<sheet-id>","sheetRange":"A:ZZ"}'
# proxy providers work the same way: {"name":"pool","sheetId":"...","hasHeader":true}
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

| Variable                       | Default         | Purpose                                                                    |
| ------------------------------ | --------------- | -------------------------------------------------------------------------- |
| `SPECTRA_PORT`                 | `50325`         | API port                                                                   |
| `SPECTRA_HOST`                 | `127.0.0.1`     | Bind address (loopback by default, on purpose)                             |
| `SPECTRA_DATA_DIR`             | `~/.queuepilot` | SQLite + profile data                                                      |
| `SPECTRA_RUNTIME`              | `camoufox`      | `camoufox` or `fake`                                                       |
| `SPECTRA_API_TOKEN`            | unset           | If set, every route except `/health` needs `Authorization: Bearer <token>` |
| `SPECTRA_GOOGLE_CLIENT_ID`     | unset           | Google Cloud OAuth client id (Sheets API) for Google Sheets providers      |
| `SPECTRA_GOOGLE_CLIENT_SECRET` | unset           | Google Cloud OAuth client secret                                           |

## Development

```bash
npm test          # vitest across workspaces
npm run typecheck # strict TS everywhere
```

Design documents: [docs/architecture.md](docs/architecture.md) and
[docs/adr/](docs/adr/) record the decisions and _why_ they were made.

## License and attribution

MIT (see [LICENSE](LICENSE)). QueuePilot is original code. Its architecture draws on
published patterns from the open antidetect ecosystem (contract-driven control
planes, deterministic lifecycle testing, AdsPower's de-facto Local API
convention); no AGPL-licensed code is used.
