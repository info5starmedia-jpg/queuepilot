# ADR-0006: Engine base — dual engine, Fury core alongside camoufox (D-004)

Status: accepted (2026-11-10)

## Context

D-004 asked: stay on camoufox (Firefox-family) or build on Fury's BSD-3-Clause
Chromium patch series? Investigation of the local Fury clone (2026-11-10)
produced facts that change the framing:

### What Fury actually offers

- **Prebuilt core binaries on GitHub Releases.** `fury-core-0.5.1-windows-x64.tar.xz`
  (150 MB) and `fury-core-0.5.1-macos-arm64.tar.xz`, Chrome 157.0.8103.39,
  with published SHA256SUMS. No Linux core build. A source build is possible
  (~100 GB sync, ~200 GB build, hours) but NOT required to adopt the engine.
- **43-patch series, BSD-3-Clause** (`core/patches/`), covering navigator/UA-CH,
  screen, canvas/audio/client-rects noise (seeded, C++-level), WebGL params,
  WebGPU adapter, fonts, media devices, WebRTC policy, timezone/ICU, locale,
  geolocation, permissions consistency, battery, network-information, and a
  full mobile-persona suite.
- **A launch contract we can implement cleanly:** the persona config is JSON
  delivered as an inherited fd (POSIX) / HANDLE (Windows) — deliberately never
  in argv — with schema version 1 and refuse-to-start on unparseable config.
  The full dotted-key schema (`navigator.*`, `screen.*`, `noise.*Seed`,
  `locale.*`, `mobile.*`…) is recoverable from the BSD patch call sites.
- **A verification culture we should copy, not the scripts:** one claim-based
  probe per patch, driven over CDP, run headed, each asserting a claim
  ("position is the configured one"), exit non-zero on any false claim.

### What camoufox gives us today

Working, integrated, C++-patched Firefox with our full lifecycle discipline —
but Firefox-family, while the ticket/queue ecosystem's detection is tuned
primarily against Chrome surfaces (UA-CH, WebGPU, client hints, battery,
netinfo don't exist in Firefox the same way, which is itself a tell).

### Legal review

- Patches: BSD-3-Clause — vendor with NOTICE, keep headers. ✅
- Prebuilt binaries: redistribution permitted under the same BSD terms +
  Chromium's license; we pin SHA-256 and gate download behind consent
  (our existing EngineInstaller model). ✅
- Fury `core/build/*.sh`, `core/verify/*.py`, agent: **AGPL-3.0 — never
  copied.** Our build/verify/launch plumbing is written from scratch; only
  the concepts (fd-3 config, claim-based verification) transfer. ✅
- Trademark: original branding only; attribution lives in `NOTICE`. ✅

## Decision

**Dual engine. Add `fury-core` as a second BrowserRuntime; camoufox stays.**

1. **fury-core runtime** (`kind: "fury"`): launches the prebuilt core with the
   persona JSON over an inherited fd/HANDLE (our own implementation of the
   documented contract), remote-debugging-port CDP for tabs and attestation —
   Chromium supports `Target.createBrowserContext` natively, so the whole
   tab/partition and attestation stack works unchanged.
2. **Distribution through the existing checksummed installer**: manifest entry
   pinned to Fury's published SHA-256, consent-gated, atomic — no silent
   downloads, unchanged from ADR-0003 discipline.
3. **Attestation is the acceptance gate** (built in v0.9.0): the spike is done
   when `GET /profiles/:id/attest` returns `match` on fury-core for every
   field our identity model declares, on Windows.
4. **Camoufox remains** the default until the spike proves out, and remains
   the Linux answer (Fury ships no Linux core). Per-profile engine selection
   comes later if dual-engine earns it.
5. **NOTICE file** gains the Fury patches/binary attribution the moment the
   first artifact lands.

## Spike plan (P4a)

1. Manifest entry + `engine install` path for fury-core windows-x64.
2. `FuryCoreRuntime` + our own fd/HANDLE config transport (Windows first).
3. Attestation green on fury-core; tab open/close green over native CDP.
4. Claim-based probe suite (`apps/api/verify/` or `core/verify/`) covering the
   fields our identity model sets — written by us, claim-style per Fury's
   documented methodology.
5. Detection pass (CreepJS, sannysoft-class surfaces) run manually first;
   CI wiring follows once probes are stable.

## Consequences

- Engine choice becomes data-driven: attestation + detection results decide
  the default, not preference. If fury-core underperforms camoufox on our
  probes, we keep camoufox and lose only the spike.
- We inherit a rebase cadence decision later (track Fury releases vs build
  our own from patches) — deferred until the spike proves value.
- Node's `child_process` on Windows can pass inheritable HANDLEs via
  `stdio` — the one genuinely new systems code in the spike.
