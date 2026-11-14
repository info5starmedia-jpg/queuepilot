# ADR-0007: Proxy rotation links — per-launch endpoint refresh (D-003)

Status: accepted (2026-11-14)

## Context

D-003 asked for a design for "proxy rotation links": the residential/mobile
provider feature where an operator is given a **URL** (not a static proxy)
and every fetch of that URL returns a fresh endpoint
(`host:port:user:pass`). Bright Data's "proxy endpoint", Oxylabs' "entry
node", Smartproxy's "endpoint generator" are all this shape. Jancy treats
them as first-class: a profile points at a link, and each launch dials the
link and gets that launch's proxy.

What we already have (this design builds on it, it does not replace it):

- **Attached proxies** (`profile.proxyId`) — a static row in `proxies`,
  credentials in the SecretStore. Stable by design: an account that logs in
  from a different city every session is a linking signal.
- **Proxy providers** (`proxy_providers` + `next()`) — refreshable pools
  with `persist` / `start-over` / `random` distribution. Rotation happens at
  *assignment/refresh* time, chosen by the operator.
- **Temporary proxies** (`tempProxy` at launch) — a per-launch proxy passed
  in the start request, never persisted. The exact plumbing a rotation link
  needs.
- **The launch-time egress contract** (P7.3): every launch measures exit IP
  through the relay *before* handing the engine its proxy, and the
  diagnostics surface serves those measurements verbatim. Any rotation
  design must keep this true — "which IP was I on" is the first question an
  operator asks after a ban.

## Decision

A rotation link is a **third provider-ish source** that materializes into
the existing `tempProxy` launch path. Concretely:

1. **Storage**: a new nullable `rotation_url TEXT` column on `proxies`
   (migration 005). A row with `rotation_url` set is a *link proxy*; its
   `host`/`port` columns stay NULL for that row. The URL itself is not a
   secret — it usually embeds credentials, but so do our proxy URLs
   today, and they travel through the same redaction rules
   (`redactProxyUrl`). No SecretStore involvement beyond what proxy URLs
   already do.

2. **Fetch at launch, never at rest**: when a profile attached to a link
   proxy starts, the API fetches the URL (10s timeout, one redirect max),
   parses `host:port:user:pass` (or `host:port` for unauthenticated), and
   feeds it into the same validation + relay path as `tempProxy`
   (`proxyUrl()` → `startProxyRelay` → loopback `--proxy-server`). The
   fetched endpoint is used for **this launch only** and is never written to
   `proxies`, the run row beyond the redacted launch snapshot, or anywhere
   durable.

3. **Fail closed, loudly**: an unreachable link, a malformed response, or a
   refused relay chain aborts the launch with a named error
   (`PROVIDER_SOURCE_UNREADABLE` family) — exactly like an unreadable CSV
   provider. A rotation link that silently falls back to direct would be
   the P0 proxy leak wearing a new hat.

4. **Fresh egress measurement per launch**: because the fetch happens
   inside `launch()` before the engine starts, the existing P7.3 flow
   (measure exit IP through the relay, record in `session.egress`,
   diagnostics serve it verbatim) applies unchanged. The one honest caveat,
   documented on the egress endpoint: between launch and the operator
   reading diagnostics, a *session-length* link may have rotated — the
   measurement is the launch's truth, not a live re-check.

5. **No mid-run rotation.** When the fetched endpoint dies mid-session, the
   run does not re-dial the link. Rotating IP under a logged-in session
   mid-flight is how accounts get linked; the operator stops and starts the
   profile to get a new endpoint.

## Alternatives considered

- **Persistent rotation** (re-fetch on a timer / on failure and hot-swap the
  relay's upstream): rejected. It churns the egress identity inside a
  session, breaks the "which IP was I on" audit trail, and adds a second
  code path that can leak. Restart-to-rotate is the discipline.
- **A separate `rotation_providers` table**: rejected. It duplicates the
  provider machinery (naming, delete discipline, refresh semantics) for a
  feature that materializes into exactly one launch input. One nullable
  column on `proxies` says what it is.
- **Doing nothing (operator pastes endpoints manually)**: that's today's
  state; it works but defeats the point of the link product and pushes
  operators toward pasting credentials into CSVs — the habit token aliases
  exist to kill.

## Consequences

- Migration 005 (`rotation_url` column) is deferred until implementation
  lands; this ADR does not change the schema by itself.
- `LaunchRequest` gains no new field: the link resolves inside the lifecycle
  service into the existing `launchProxyUrl`/`proxySource` pair
  (`proxySource: "rotating"`).
- Verify suite: a claim `rotation-link-launch` against a recording rotation
  endpoint fixture — two consecutive launches must receive DIFFERENT
  endpoints from a stub that rotates, proving per-launch refresh.
- Parity row in `docs/parity-jancy.md` (proxy rotation link) flips when
  implementation merges.
