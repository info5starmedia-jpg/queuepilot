# ADR-0001: Clean foundation, contracts first

Status: accepted (2026-11-06)

## Context

Open antidetect projects tend to grow as scripts around a browser binary:
lifecycle state lives in globals, "APIs" are ad-hoc, and the failure modes
(double launch, zombie processes, half-written profile dirs) are found by
users. We studied three public codebases before writing code and took their
best structural ideas: contract-driven typed APIs, a failure-first lifecycle
test model, and per-patch engine verification.

## Decision

QueuePilot is a control plane built contracts-first:

- All cross-boundary shapes are Zod schemas in `packages/contracts`, shared by
  server, tests and future clients.
- The browser engine sits behind a `BrowserRuntime` port; a deterministic fake
  implements it for tests.
- Lifecycle invariants (see docs/architecture.md) are enforced by the database
  schema, not just by code.
- No browser engine is bundled or auto-downloaded.

## Consequences

The whole system — including double-launch races and crash recovery — is
testable in milliseconds without a browser. Adding a new engine means
implementing one interface. The cost: the API cannot launch a real browser
until an engine binary is installed; we accept that trade for a foundation
that does not lie about its state.
