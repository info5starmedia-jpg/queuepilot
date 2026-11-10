# engine/ — QueuePilot's own engine patchset

This directory is QueuePilot's **owned** engine layer. It vendors Fury's
`core/` patch series and build chain so the project can build, patch, rebase
and verify its own Chromium without depending on upstream's release cadence.

## Provenance and license (do not remove)

- `patches/` — the Fury fingerprint patch series, **BSD-3-Clause**
  (`patches/LICENSE`, Copyright 2026 The Fury Authors). Redistribution in
  source and binary form is permitted **provided the copyright notice stays**.
  This is the only license covering the patches; the Fury repo root's AGPL
  applies to Fury's *application* code, which is NOT vendored here and never
  will be.
- `build/`, `verify/` — Fury's build/verify tooling (AGPL-3.0). Tools, not
  product: running them does not license the output. Keep their headers
  intact anyway; they carry hard-won operational knowledge.
- `args/` — GN build arguments per target (release vs dev vs low-mem).
- `CHROMIUM_VERSION` — the Chromium tag this series applies to
  (currently `157.0.8103.39`).

Source: https://github.com/furyteamtop/fury-antidetect-browser (`core/`).
Upstream-to-date check is part of the engine-bump ritual (below).

## What this gives us

- **Ownership**: the patches are ours to modify, extend and rebase — legally
  clean, forever.
- **Independence**: we can build our own `queuepilot-core` binary the day
  upstream goes stale, instead of waiting on their prebuilt releases.
- **Fixability**: when `apps/api/verify` (the claim suite) finds an
  engine-level gap, the fix lands here as a new numbered patch — one patch
  per vector, per the house rule documented in `patches/series`.

## Status

**Patchset vendored (v0.11.x); first own build NOT yet run.** The shipping
runtime still uses upstream's prebuilt fury-core 0.5.1 (checksum-pinned,
consent-gated installer). The own-build milestone is tracked in
`docs/roadmap.md` (P4c) and its green gate is defined in `docs/parity.md`.

## The engine-bump ritual (when updating Chromium)

1. Edit `CHROMIUM_VERSION` to the new tag.
2. `engine/build/fetch.sh <tag>` — sync the source tree (~100GB, internal
   NVMe only; the machine needs ≥150GB free).
3. `engine/build/rebase.sh` — port the series; every conflict is localisable
   to one named vector (that is what the one-patch-per-vector rule buys).
4. `engine/build/build.sh windows-x64` — 6–12h on the reference machine
   (Xeon 6c/12t, 32GB); run overnight, do not delete `out/` between runs.
5. `python engine/verify/run-all.py` — Fury's per-patch harness on the new
   binary.
6. `npm run verify --workspace apps/api -- --engine fury` — QueuePilot's
   claim suite must read 16/16 (or more, as claims are added) on OUR binary.
7. Only then: publish the tarball + sha256 into the engine manifest and
   bump the pinned version in `engines.manifest.json`.

A build that fails step 5 or 6 does not ship. No exceptions.

## Adding a new vector

1. One patch, one vector. Number it in the band documented in
   `patches/series` and add it there with a comment explaining the
   measurement that justifies it.
2. Add `engine/verify/verify-NNNN.py` proving the patch on a live build —
   including a control that fails when the patch is absent (a control that
   passes when broken is not a control).
3. Add a matching claim in `apps/api/verify/claims.ts` so the drift gate
   catches a future regression.
