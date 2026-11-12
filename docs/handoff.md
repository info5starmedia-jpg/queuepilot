# Handoff — read this first (for the next engineer, human or LLM)

You are continuing QueuePilot, a local-first anti-detect browser orchestrator.
This file is the contract. If anything here contradicts other docs, this file
wins; update it when reality moves.

## The 100% mission — stick to this and nothing else

> Profiles that are indistinguishable from real stock-Chrome users, with
> launch identity as a durable, attestable, drift-visible record — proven by
> measurement, never by assumption.

Three layers, three sources, one product: **Fury's engine knowledge** (BSD
patches, vendored in `engine/`) + **AliasMode's lifecycle discipline**
(re-implemented, Apache-2.0) + **Jancy's workflow ideas** (docs only, closed
source — never copy code that doesn't exist to copy).

## Do not change (invariants)

1. **One patch = one fingerprint vector** in `engine/patches/series`. Never
   mix vectors; rebase conflicts must localise to a named concern.
2. **Claims are calibrated against stock Chrome, not detector folklore.**
   Ground truth measured 2026-11-10 (Chrome 156/157): web pages get
   `window.chrome = {loadTimes, csi[, app]}` — `chrome.runtime` is NOT
   exposed to web pages; `Notification.permission` "default" vs
   `permissions.query` "prompt" is the SAME state. Re-baseline with
   `npm run verify:calibrate --workspace apps/api` on Chrome version bumps.
3. **Skip, never fake.** An unobservable field is skipped in attestation and
   claims; a control that passes when broken is not a control.
4. **Refuse loudly, never silently degrade.** A runtime that cannot honor a
   configured proxy/identity must error, not fall back to direct/real values.
5. **License hygiene**: `engine/patches/LICENSE` (BSD, Fury copyright notice)
   stays. Fury application code is AGPL — never vendor it. AliasMode ideas
   re-implemented, not copied. Jancy: ideas only.
6. **No consent, no download** — the engine installer stays consent-gated,
   checksum-pinned, atomic.
7. Versions bump together: root, `apps/api`, `packages/contracts`,
   `packages/client`.

## Verified facts (measured on this repo, don't re-derive)

- v0.12.6, 188 tests green (25 files), typecheck clean.
- v0.11.0, 138 tests green, typecheck clean, 16/16 claims PASS live on
  fury-core 0.5.1 (Chrome 157.0.8103.39), Windows 11, loopback probe page.
- Fury persona delivery: JSON `schema_version: 1` via inherited HANDLE,
  switch `--fury-fp-file-handle=<uint32>`. Windows quirks already solved:
  `SetHandleInformation(handle, 1, 1)` is required (.NET handles are not
  inheritable); mask the IntPtr to the 32-bit handle value.
- Upstream marked the Windows HANDLE half "never run" — we ran it; it works.
- **P0 proxy leak (found in the P4 audit): FIXED v0.12.0.** The fury runtime
  now fronts every configured proxy with an auth-injecting loopback relay
  (`apps/api/src/application/runtime/proxy-relay.ts`), refuses loudly
  (PROXY_UNSUPPORTED) what it cannot honor (socks5), and the
  `egress-via-proxy` claim proves the chain live (`--proxy` mode).
- Git pushes: if `git push` hangs (Credential Manager), use
  `powershell.exe -File ../spike/push-with-cred.ps1 "<repo abs path>"`.

## Green gates before every commit

```bash
npm run typecheck   # 0 errors
npm test            # all green
npm run build       # clean
# engine/runtime changes also:
npm run verify --workspace apps/api -- --engine fury --data-dir <dir>   # all PASS
npm run verify --workspace apps/api -- --engine fury --proxy --data-dir <dir>  # + egress proof
```

## Repo map

- `apps/api/src/` — API, runtimes (`application/runtime/`, incl.
  `proxy-relay.ts`), lifecycle, CDP
- `apps/api/verify/` — detection claim suite (`claims.ts`, `run.ts`,
  `calibrate-stock-chrome.ts`)
- `apps/api/src/dashboard/` — zero-build vanilla console (React migration is
  ADR-0005, console-depth track)
- `packages/contracts`, `packages/client` — shared types, typed client
- `engine/` — vendored Fury patchset + build chain (see `engine/README.md`)
- `docs/adr/` — decisions 0001–0006 · `docs/roadmap.md` · `docs/parity.md`

## Next tasks, in order (detail in docs/parity.md §4)

1. **P4c: first own build — RUNNING overnight 2026-11-12.** Build root
   `C:\queuepilot-engine` (outside the repo, deliberate). Sync done (exit 0),
   41/41 patches applied, compile config `windows-x64-first-16gb` (first-build
   isolation + `concurrent_links = 1` for the 16 GB machine). Machine fixes
   already applied (don't redo): `DEPOT_TOOLS_WIN_TOOLCHAIN=0`,
   `vs2022_install` → VS **18** BuildTools,
   `WINDOWSSDKDIR` → Windows Kits\10, `dbghelp.dll` staged into
   `Windows Kits\10\Debuggers\x64` (UAC), QueuePilot icon generated at
   `C:\queuepilot-engine\assets\icon.png` (Fury's branding is NOT ours to
   ship), layout fix in our copy of `build/link-icons-windows.ps1`.
   Log: `C:\queuepilot-engine\build.log`. When `build-wrapper exit: 0`:
   run the verify gate below against the fresh binary, then report; the
   overnight monitor task posts progress into the workspace every 2 h.
2. When the binary verifies: switch compile config to `windows-x64.gn`
   (official build, LTO+PGO) for the shippable core, and only then publish
   our own tarball in the engine manifest.
3. Claim sweep ✅ done (v0.12.1 + v0.12.2 — 10 new claims, 157+ tests).
   Lifecycle P1s ✅ done: window-fit v0.12.3, admission slots v0.12.4,
   session bundles v0.12.6. P6 secrets ✅ done (v0.12.5, DPAPI).
4. Remaining known gaps (parity.md §1/§2): speech personas await a persona
   voices field; scrollbar claim awaits upstream Windows compile; os-crypt
   wiring (0110, P2); egress diagnostics API (P2); extensions registry,
   TOTP, socks5 (P2); team server/roles (P5 remainder).
5. **Unpushed local commits await operator approval** (v0.12.4–v0.12.6 +
   docs); v0.12.1–v0.12.3 ARE on GitHub. Push with the credential fallback
   after the operator says so.
