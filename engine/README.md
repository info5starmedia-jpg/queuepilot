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

**P4c in progress (2026-11-11).** The shipping runtime still uses upstream's
prebuilt fury-core 0.5.1. First own build underway:

- Build root is `C:\queuepilot-engine` (NOT `engine/src/` — the repo lives
  in a OneDrive-synced folder; a 100GB source tree there would be a
  disaster). `engine/` here is the patchset's source of truth; it is copied
  to the build root, builds happen there.
- Toolchain present: VS Build Tools 2026 (MSVC 14.51), Windows 11 SDK
  10.0.26100, depot_tools at `C:\queuepilot-engine\depot_tools` (bootstrap
  done). ATL/MFC NOT installed — first build will tell us if recent
  Chromium needs it.
- **Headless-launch traps, all measured on this machine (do not
  re-derive):**
  1. GCM hangs forever headless → always `GIT_TERMINAL_PROMPT=0
     GCM_INTERACTIVE=never` (googlesource is public, anonymous is fine).
  2. PowerShell `Start-Process bash -ArgumentList '-c', '<inline script>'`
     garbles inline commands → pass ONE script-file argument instead
     (`/c/queuepilot-engine/sync-run.sh`).
  3. This agent session's environment is STRIPPED of Windows vars
     (PROCESSOR_ARCHITECTURE, ProgramFiles...) → `platform.machine()` is
     `''` → gclient sets `host_cpu=''` → DEPS conditions crash with a
     cryptic `ast.parse: SyntaxError` at "line 0". `sync-run.sh` restores
     the essentials before invoking gclient. A desktop shell never sees
     this.
  4. depot_tools only bootstraps through its NATIVE Windows entry
     (`gclient.bat`); the POSIX path silently no-ops.
  5. gclient_eval.py / gclient.py in the build root carry temporary
     QP-DEBUG instrumentation; `git -C depot_tools checkout .` cleans it.

## The engine-bump ritual (when updating Chromium)

1. Edit `CHROMIUM_VERSION` to the new tag.
2. Run the fetch from the build root: `bash /c/queuepilot-engine/build/fetch.sh <tag>`
   (~100GB, internal NVMe only; the machine needs ≥150GB free). For the
   gclient sync step use `sync-run.sh` (env restoration) rather than raw
   gclient.
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
