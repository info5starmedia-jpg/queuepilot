# Upstream scan — Fury 0.5.2–0.5.5 & AliasMode (2026-11-14 evening)

Scan of both upstream repos' commits since the morning scan (roadmap P7 item 9).
Verdict per item: **adopted now** (code in this batch) · **already had** ·
**engine-side next rebuild** (P8, needs a Chromium rebuild) · **deferred**
(recorded for its track) · **out of scope** (not QueuePilot's mission).

## Fury (furyteamtop/fury-antidetect-browser)

### 0.5.4 core commits (2026-11-13)

- **Bookmark sets** (`70d26114`) — **adopted now**. We already had
  marked-node replacement (P7.9); the missing nuance was "a colleague's set
  that came in a bundle is never touched". We now keep a machine-side record
  of every set id ever applied (`bookmark-set-ids.json`); only known ids are
  cleaned when they drop out of the config, unknown markers survive, and an
  emptied config cleans managed folders. New tests cover all three.
- **Extensions from .zip or folder** (`98f5167d`, issues 27–30) — **adopted
  now**. Pinned ids and .crx/.zip/folder install already existed (P7.5); the
  gaps were: manifest nested one folder down (now lifted, only when exactly
  one root subdir holds it), and Finder `__MACOSX` junk (now dropped in both
  the zip extractor and folder copies). New tests cover both.
- **Named launch refusals** (`86228ddd` core issues 31–33 are C++; the
  *agent-side* piece below) — see cdp_readiness.
- **Core 0052 Local Font Access / 0123 built-in AI / 0071 WebRTC** (`86228ddd`)
  — **engine-side next rebuild**. C++ patches into Chromium and
  third_party/webrtc; Fury's own baseline moved to the 0.5.4 core. Queued for
  the next engine rebuild with the rest of P8; until then our engine reports
  whatever the 0.5.x binary materializes and attestation keeps measuring it.
- **Account recovery key, "Forgot password?", owner hand-over** (`61b2cacd`,
  0.5.5) — **deferred to the team-server track** (P7 remainder). Client-side
  wrapping of the private key under a 256-bit recovery key + Argon2id
  verification is the design to follow when team server lands; QueuePilot has
  no accounts/keys today, so there is nothing to retrofit.
- Proxy flag/country in pickers, examples/automations catalogue — UI polish;
  fold into the React console track.

### Fresh egress check on proxied launches — **already had**

Fury's 0071 commit stresses: "the agent passes the address from a fresh exit
check on every proxied launch, since a stale one from a rotating proxy would
contradict the address sites see." Verified: `fury-core.runtime` runs
`egressIpViaRelay(relay.port)` against the just-started relay on every
proxied launch, and only that fresh value feeds the engine's WebRTC config
(`publicIp`/`hostName`) plus the launch snapshot's egress block. A failed
check degrades to "no WebRTC override", never a stale address.

## AliasMode (aliasmode/aliasmode)

- **Name every launch refusal** (`623e59b2`, PR #219) — **adopted now**. We
  already named `process_spawn` and `engine_start`; the missing stage was
  CDP readiness — the bootstrap PID proves the process started, not that the
  DevTools endpoint answers. `waitForCdpReady` now polls
  `/json/version` (15 s) after the PID report; a dead endpoint refuses the
  launch as `cdp_readiness: …` with full cleanup (bootstrap killed, relay
  closed). Unit-tested against a real loopback server both ways.
- **Proxy-cache backfill racing a launch** (same PR) — **already covered by
  design**. AliasMode's bug: a background refresh rewrote the profile row
  mid-open and aborted the launch as "profile changed". QueuePilot's
  provider refresh is an upsert that never churns identity or run state, and
  the lifecycle never aborts a launch because the row changed under it —
  edits while running are drift, by design. No code change; noted so the
  mistake stays unmade.
- **In-app AI agent** (runner, chat page, credits/wallet, MCP catalog,
  `d7383aa8`…`99358bcf`) — **out of scope**. A hosted-credits product
  direction; QueuePilot is local-first with no accounts and no wallet, and
  the mission is the Jancy workflow layer, not an AI agent. The durable idea
  worth keeping: "replace a crashed tool host, and answer tool calls cut by
  an app exit" is good process-hygiene thinking for any long-running worker —
  revisit when QueuePilot gets background jobs.
- Firefox tab-crash / updater fixes — not applicable (Chromium-only
  runtimes, no auto-updater).

## Test count

373/373 green (9 new this batch), typecheck 0, build clean.
