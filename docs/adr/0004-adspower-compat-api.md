# ADR-0004: AdsPower-compatible Local API

Status: accepted (2026-11-06)

## Context

A large amount of existing automation (ad farms, ticket tooling, account
warm-up scripts) is written against AdsPower's local HTTP API: loopback,
default port 50325, envelope `{ code, msg, data }`, endpoints
`/api/v1/browser/start|stop|active`, `/api/v1/profile/*`, where errors are
`code != 0` with HTTP 200 — not HTTP status codes.

## Decision

QueuePilot implements that surface as-is, on the same default port, alongside its
own native REST API (which uses proper HTTP status codes and typed error
bodies). Compat endpoints translate internally: domain errors become
`{ code: 1, msg }`.

## Consequences

Existing tooling points at QueuePilot with zero changes — the strongest adoption
shortcut available. The cost is maintaining two API shapes; the compat surface
is kept deliberately thin and fully covered by contract tests
(`tests/adspower.api.test.ts`).
