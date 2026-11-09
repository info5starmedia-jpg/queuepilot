# ADR-0002: Synchronous SQLite driver

Status: accepted (2026-11-06)

## Context

The double-launch guard must be atomic across the "check occupying run →
create run row" pair. With an async driver, that pair spans event-loop ticks
and needs careful locking; with Node's async ecosystem it is easy to get
subtly wrong.

## Decision

Use better-sqlite3 (synchronous) with WAL mode and foreign keys on. The
launch guard is a partial unique index, and every guard mutation is one
statement inside one sync call stack. An in-process per-profile mutex
serializes lifecycle operations so the common case never even hits the
constraint.

## Consequences

No event-loop interleaving inside critical sections; the constraint cannot be
defeated by a race. DB calls block the event loop for microseconds — measured
irrelevant at profile-management scale, and the API is per-machine local, not
a multi-tenant server.
