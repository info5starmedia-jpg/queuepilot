# Upstream scan — Fury 0.5.6–0.5.7 & AliasMode beta.75 track (2026-11-17)

Scan of both upstream repos' commits since the 2026-11-14 evening scan
(`docs/upstream-scan-2026-11-14.md`). Same verdict vocabulary: **adopted
now** · **already had** · **engine-side next rebuild** · **deferred** ·
**out of scope**.

## Fury (furyteamtop/fury-antidetect-browser) — 6 commits since 11-14

- **Real HTTPS proxies: TLS to the proxy itself (#37, `8854023`, 0.5.7)** —
  **already had, one diagnostic gap open.** Fury's relay dialled `https://`
  proxies as plain TCP (every page a 502); their fix adds rustls to the
  agent's relay. Our `apps/api/src/application/runtime/proxy-relay.ts`
  already opens `tls.connect({host, port, servername})` for
  `protocol === "https"` — we never had the bug. Their companion
  diagnostic is worth adopting, app-side and small: when the proxy Test
  fails with a TLS error on an `https` proxy, retry the check as plain
  `http` and suggest changing the saved type (Fury: `notTls` → suggested
  kind `http`). Queued as a proxy-Test improvement; no rebuild.
- **No new `core/` C++ patches in 0.5.6 or 0.5.7** — diff between the
  release commits touches only the agent (relay/diagnose), desktop i18n,
  and catalogue data. Nothing to vendor; the queued 0052/0123/0071 set
  from the 11-14 scan stays the rebuild backlog (P8).
- Brazilian/Portuguese site i18n, catalogue machine entries — out of scope.

## AliasMode (aliasmode/aliasmode) — 12 commits since 11-14

- **AI agent: material advancement** (`60d7b1a`, `284be9a`, `5a83cad`,
  `eaf6d42`, `86ef924`, beta.75 `d9cf1d6`/`bd71ccf`) — **OWNER DECISION
  REQUIRED.** Since the 11-14 standing note ("if AliasMode materially
  advances the AI feature, we explore adding it — local-model / no-credits
  form"), they shipped: the agent on the web dashboard (MCP host in-process
  in a source checkout, no desktop capability needed), Agent UI v2
  (ChatGPT/Claude-style chat, floating launcher, side panel), agent guards
  (hide `browser_run_code`, uploads only from the agent files folder, 1 GB
  cap, newest-200-chats retention), and a released tool catalog
  (beta.75). That is a material advance by the note's own test. The
  QueuePilot-shaped version, if the owner says go: an agent loop over OUR
  own local API + JYL + plugins (the tools already exist), local model
  only, no accounts, no wallet, no credits. Effort estimate and plan
  belong in a dedicated P-item, not this scan.
- **Firefox add-ons, Playwright URL, bring-to-front (`8aa62a5`,
  `c252348`, PR #224)** — out of scope. Firefox-runtime-specific; the
  Chromium-only architecture decision was reconfirmed by the owner
  2026-11-17 (reasons in the session; not re-litigated here).
- **proxyFrom — reuse another profile's proxy without exposing it
  (`86ef924`)** — **already had by design.** Our proxy list API returns
  `password: null`; passwords live in the DPAPI SecretStore and only the
  relay ever sees them. Profiles already share a proxy by pointing at the
  same proxy id — no credential is ever exposed to copy. (AliasMode's
  variant exists because their *agent* edits profiles over an API that
  serializes proxy credentials; ours never serializes them.)
- **Show proxy host:port in the list, clearer launch errors (`86ef924`)**
  — launch errors: already had (named refusals, PR #219 taxonomy adopted
  11-14). Host:port display: UI polish, fold into the React console track
  if not already present.

## Net for this week

1. Proxy-Test `notTls` diagnostic (adopt Fury's, app-side, small) — add to
   the Phase A/B batch.
2. AI agent exploration — owner decision; if yes, dedicated P-item scoped
   local-only (agent loop over our API + JYL + plugins, no wallet).
3. Nothing new for the engine patch series; rebuild queue unchanged
   (0052/0123/0071).
