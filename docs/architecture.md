# Architecture

QueuePilot is a control plane for browser engines, not a browser. The split is the
point: the hard, correctness-critical part of multi-account tooling is lifecycle
and state, and it deserves to be engineered (and tested) independently of any
engine.

```
┌────────────────────────────────────────────────────────┐
│ clients: automation (AdsPower Local API), UIs (native  │
│ REST + SSE), scripts                                   │
├────────────────────────────────────────────────────────┤
│ apps/api (Fastify)                                     │
│  http/        routes, error mapping, SSE               │
│  application/ profile service · proxy service ·        │
│               lifecycle service · runtime port         │
│  infrastructure/ sqlite (migrations) · process probe   │
├────────────────────────────────────────────────────────┤
│ packages/contracts — Zod schemas shared by everything  │
├────────────────────────────────────────────────────────┤
│ runtime port ◀── FakeBrowserRuntime (tests/CI)         │
│               ◀── CamoufoxRuntime   (real engine)      │
│               ◀── future: own Chromium fork            │
└────────────────────────────────────────────────────────┘
```

## Lifecycle invariants

These are enforced by construction, and each has a test:

1. **One occupying run per profile, twice-guarded.** In-process: a per-profile
   async mutex serializes lifecycle ops. Durable: a partial unique index
   (`WHERE status IN ('launching','running')`) in `browser_runs` — the database
   itself rejects a second occupying run even if every higher layer is bypassed.
2. **Intent before action.** A run row in `launching` state is written before the
   engine spawns. If the API dies mid-launch, recovery sees the intent.
3. **No in-memory-only state.** Run status, pid, debug port and ws endpoint live
   in SQLite. Memory holds only the session handle.
4. **Idempotent stop.** Automation retries are a fact of life; stopping a stopped
   profile is a success no-op.
5. **Reconcile before serve.** On boot, occupying runs are checked against real
   OS processes (`process.kill(pid, 0)`): alive → adopted as running, dead →
   marked crashed and the profile freed. (Known limit: PID reuse. See roadmap
   D-002 — store the process start token per platform.)

## Why synchronous SQLite

better-sqlite3 is sync (ADR-0002). Profile operations are microsecond-scale;
a sync driver removes async ordering from the correctness-critical path and
keeps every launch-guarding mutation inside one transaction.

## Fingerprint identities

Immutable rows, generated from a single seed by pure functions. Every derived
value (screen, cores, memory) is drawn from sets real machines ship in, with
cross-field coherence enforced (a 4 GB machine never claims 32 cores).
"Changing" a fingerprint creates a new identity and re-points the profile
atomically; history is never mutated.

## Engine adapters

The `BrowserRuntime` port is ~20 lines. FakeBrowserRuntime models launch
failure, slow start and abrupt crash, which is how the lifecycle test suite
exercises every path deterministically. CamoufoxRuntime spawns the Camoufox
binary with a per-profile data dir, remote debugging port, and the identity
passed as Camoufox config JSON. The engine is never auto-downloaded
(ADR-0003) — supply-chain silence is a feature.
