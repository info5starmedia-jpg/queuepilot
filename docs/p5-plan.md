# P5 — Hardening & Polish (draft, 2026-11-13)

Preconditions: P4c complete — official LTO+PGO build verified (harness
40/40, claims 25/25 + proxy green), tarball published, `engines.manifest.json`
bumped to a `-qp.` version, parity audit green.

## P5.1 — Norton / AV coexistence (owner: user action + agent support)

Why: Norton File Insight quarantines `out\<dir>\chrome.exe` ~15 min after
every link and name-locks the path forever, even with protection "paused".
Current workarounds (out-dir renames, stash restore, build watchdog) are
band-aids.

- [ ] User: Norton → Settings → Antivirus → Scans and Risks → Exclusions /
      Low Risks → add `C:\qe` to **Scan Exclusions**, **Auto-Protect
      Exclusions**, and **SONAR Exclusions** (three separate lists).
- [ ] Agent: after exclusion, verify by relinking chrome.exe into the
      original `windows-x64-first-16gb.noindex` dir and confirming it
      survives 30 min.
- [ ] Agent: write `docs/av-notes.md` for family/friends installs — what to
      tell Norton/Avast/Defender about an unsigned self-built browser, and
      why (reputation-based flags on unsigned binaries; source-auditable).
- [ ] Long-term: evaluate Authenticode self-signing + installing the root
      cert on family machines (removes the "unsigned" flag entirely).

## P5.2 — Engine auto-update channel

Why: `engines.manifest.json` already carries version/url/sha256/sizeBytes;
today a human builds and bumps it by hand. Family installs need to pull
security patches (Chromium ships weekly).

- [ ] `queuepilot engine update` command: fetch manifest from the repo's
      raw URL, compare against installed receipt, download + verify sha256,
      swap atomically (keep last-good dir for rollback).
- [ ] Document the patch-rebase flow: `git fetch` Chromium tag →
      `build/patches.sh` rebase report → fix rejects → rebuild → verify
      40/40 → publish `-qp.N+1`. Target cadence: monthly or on Chromium
      security advisories, whichever first.
- [ ] Versioning rule: `-qp.N` increments only on published, verified builds.

## P5.3 — Media/DRM decision (Widevine)

Status: Widevine payload is stripped (same as Fury). Netflix/Spotify-grade
DRM will not work without it.

- [ ] Decide: ship a separate "media" engine variant with the Widevine CDM
      (user accepts Google's license on first use), or document the
      limitation. Note: CDM is per-machine licensed, not redistributable in
      our tarball — installer would fetch it from Google at first run.
- [ ] Whichever way: one page in docs stating exactly what works
      (YouTube yes, Netflix no/yes) so nobody files it as a bug.

## P5.4 — Human-gated verify tier

- [ ] Run `verify-0303.py <binary> --human` once with a person approving the
      Windows Hello prompts (export + single-read, with and without
      `--fury-lock-data-export`). Record results in handoff.
- [ ] Bookmark export refusal: needs a human at the file dialog (or a
      SelectFileDialog stub build) — schedule with the same session.

## P5.5 — Installer for family/friends

- [ ] `scripts/package-installer.ps1`: NSIS or simple zip + setup.ps1 that
      drops the engine into `%LOCALAPPDATA%\QueuePilot\engines\...`, writes
      the install receipt, and prints the AV-exclusion note.
- [ ] First-run checklist in the console: engine present, claim suite quick
      pass, proxy test.

## P5.6 — Perf & startup

- [ ] Cold-start measurement (launch → first page) on the official build;
      budget < 2.5 s on this machine.
- [ ] Profile dir hygiene: confirm no `DevToolsActivePort` staleness, no
      leftover Singleton* locks after hard kills (0110's graceful-close
      findings apply).

## Explicit non-goals for P5

- No new fingerprint surfaces (that's engine work, frozen until P6 needs it).
- No UI redesign of the console.
- No commercial/paid features — family & friends build.
