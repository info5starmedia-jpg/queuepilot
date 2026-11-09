# ADR-0003: Camoufox as the first engine, never auto-downloaded

Status: accepted (2026-11-06)

## Context

The engine is the one component where quality is measured by third parties
(detection checkers), and building a patched Chromium fork is a months-long
effort with heavy build infrastructure. A v0 that bundles nothing cannot
demonstrate real launches; a v0 that silently downloads a browser binary is a
supply-chain liability.

## Decision

- First-class engine: **Camoufox** — a C++-patched Firefox, open source,
  actively maintained, already proven against public checkers.
- The binary is installed by the operator (`SPECTRA_CAMOUFOX_PATH` or
  `<dataDir>/engines/camoufox/`). QueuePilot never downloads executables.
- If the binary is missing, `start` fails with `ENGINE_UNAVAILABLE` (HTTP 503,
  AdsPower `code: 1`) — loud, not silent.
- The `BrowserRuntime` port leaves room for a later own-fork engine
  (roadmap P4) without touching the lifecycle.

## Consequences

Users get a real fingerprint-resistant browser on day one with one manual
install step; the project ships zero opaque binaries; the fork track stays
open.
