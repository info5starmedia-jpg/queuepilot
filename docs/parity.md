# Parity checklist — what Fury and AliasMode have that QueuePilot must have

This is the product's completeness contract. Three layers, three sources, one
product:

| Layer | Source | License |
| --- | --- | --- |
| Engine (identity at C++ level) | Fury `core/patches/` — vendored in `engine/` | BSD-3-Clause (notice retained) |
| Profile lifecycle (app brain) | AliasMode — discipline re-implemented, never copied | Apache-2.0 |
| Workflow (daily-driver UX) | Jancy docs — ideas only, Jancy is closed-source | ideas are free |

Legend: ✅ done · 🟡 partial · ❌ missing · ⬜ intentionally out of scope

---

## 0. Green gates — a release ships only when ALL are green

1. `npm run typecheck` → 0 errors
2. `npm test` → all green (currently 138)
3. `npm run build` → clean
4. `npm run verify --workspace apps/api -- --engine fury --data-dir <dir>`
   → every claim PASS on the binary we ship (currently 16/16)
5. Engine bump only: `python engine/verify/run-all.py` green on the new
   binary, then gate 4 re-run against OUR build
6. Manual, on every engine bump (never in CI — third-party mood is not a
   gate): CreepJS, sannysoft, fv.pro, pixelscan — results recorded in the
   commit message of the engine bump

A claim that cannot be observed must be skipped, never faked. A control
that passes when broken is not a control (Fury's rule — now ours).

---

## 1. Engine vector parity (Fury patch series vs our verification)

The binary (fury-core) implements the vectors; our `apps/api/verify` claim
suite is what PROVES they hold. A vector without a claim is unverified
trust in the binary — acceptable short-term, tracked below to close.

| Patch | Vector | Binary | Claim coverage | Status |
| --- | --- | --- | --- | --- |
| 0001 | config plumbing to every renderer/worker/iframe | ✅ | `worker-consistency` | ✅ |
| 0010 | navigator basics + Accept-Language | ✅ | `persona-platform`, `persona-locale` | ✅ |
| 0011 | UA + Client Hints single source | ✅ | `ua-stock-shaped`, `uach-consistent` | ✅ |
| 0012 | hardwareConcurrency / deviceMemory | ✅ | `persona-cores` (deviceMemory unbindable — Chromium omits it in some contexts) | 🟡 |
| 0020 | screen/window + CSS media agreement | ✅ | `persona-screen`, `persona-screen-h` | ✅ |
| 0021 | scrollbar width (3 themes) | 🟡 Windows side uncompiled upstream | none | ❌ claim owed |
| 0030 | canvas noise at readback | ✅ | `canvas-deterministic` | ✅ |
| 0031 | WebGL params + readPixels noise | ✅ | `webgl-coherent` | ✅ |
| 0032 | WebGPU adapter narrowing | ✅ | none | ❌ claim owed |
| 0033 | client rects noise | ✅ | none | ❌ claim owed |
| 0040 | audio noise | ✅ | none | ❌ claim owed |
| 0041/0042 | speech voices (+ Google network voices) | ✅ | none | ❌ claim owed |
| 0050/0051 | font fallback/platform filters | ✅ | none | ❌ claim owed |
| 0060 | media device narrowing | ✅ | none | ❌ claim owed |
| 0070 | WebRTC IP policy (the worst leak class) | ✅ | none | ❌ **claim owed — P1** |
| 0080/0081 | timezone / Intl locale everywhere | ✅ | `persona-timezone`, `persona-locale` | ✅ |
| 0082 | geolocation provider seam | ✅ | none | ❌ claim owed (needs persona geolocation field first) |
| 0090 | permissions consistency | ✅ | `permissions-consistent` | ✅ |
| 0110 | per-profile os-crypt key | ✅ in binary | not wired — our runtime doesn't pass the oscrypt handle | ❌ P2 (needed for portable profiles) |
| 0120 | performance.memory | ✅ | none | ❌ claim owed |
| 0121 | battery (desktop-mains tuple) | ✅ | none | ❌ claim owed |
| 0122 | network information | ⬜ upstream retired: Chrome's own designed noise; pinning would be a NEW tell | — | ⬜ |
| 0130–0136 | mobile persona suite | ✅ in binary | our identity model is desktop-only | ❌ P3 |
| 0300 | cdc_/automation var removal | ✅ | `no-automation-traces`, `webdriver-hidden` | ✅ |
| 0302 | devtools lock | ✅ | we NEED CDP — the lock is for restricted operators, off in our launches | ⬜ |
| 0303 | data-export lock | 🟡 upstream: unverified on live browser | n/a | ⬜ |
| 0305 | background window | ✅ | n/a (launch presentation) | ⬜ |
| 0900–0904 | branding / de-Googling / window title | ✅ | `chrome-object` (surface), UA brand list via `uach-consistent` | ✅ |
| 0013/0061/0100/0200–0230 | retired upstream with measured justification (plugins, codecs, CSS media, JA3/H2/header-order) | ⬜ | — | ⬜ do not revive without new measurement |

**Inherited known gaps (upstream-documented, honestly carried):**

- **QUIC/HTTP3**: the core launches with `--disable-quic` because UDP would
  bypass a TCP proxy relay; real Chrome upgrades to HTTP/3, we don't. Server-
  side visible. Exit = MASQUE-capable relay (RFC 9298), not a Chromium patch.
- **0301 CDP timing tell**: `Runtime.enable` makes console.* measurably
  slower (2.7×–9×); unfixable at the Blink layer, needs a v8 patch or
  acceptance. Any CDP-driven session carries it — including ours.
- **0021 Windows**: written, never compiled upstream; first own build must
  run `engine/verify/verify-0021.py` on Windows.
- **0001/0110 Windows HANDLE path**: upstream says "never been run" — WE ran
  it live in P4a (persona materialized, attestation match, 16/16 claims).
  QueuePilot is ahead of upstream here.

---

## 2. Lifecycle parity (AliasMode discipline vs QueuePilot)

| Capability | AliasMode | QueuePilot | Status |
| --- | --- | --- | --- |
| Launch-identity snapshot (identity of record) | ✅ | ✅ | ✅ |
| Edit-while-running + drift report | ✅ | ✅ | ✅ |
| Fingerprint attestation (asked vs materialized) | ✅ | ✅ | ✅ |
| Engine health / self-test | ✅ | ✅ | ✅ |
| Clean teardown, process identity proof | ✅ | ✅ | ✅ |
| Temporary (one-shot) proxies | ✅ | ✅ | ✅ |
| Proxy providers (CSV/Sheets, rotation) | ✅ | ✅ | ✅ |
| Tab/session partition isolation | ✅ | ✅ CDP browser contexts | ✅ |
| **Proxy actually applied on EVERY engine** | ✅ auth-injecting local relay | ✅ camoufox native; fury via auth-injecting loopback relay | ✅ v0.12.0 |
| Host-wide lifecycle admission slots (concurrency guard) | ✅ | 🟡 per-profile double-launch guard only | ❌ P1 |
| Window fit (window ≤ claimed screen) | ✅ `window-fit.ts` | 🟡 we set `--window-size` only | ❌ P1 |
| Session bundle export/import (cookies via CDP, roaming) | ✅ | ❌ | ❌ P1 |
| Egress diagnostics (per-profile exit IP/geo proof) | ✅ | 🟡 harness-level `egress-via-proxy` claim; no per-profile API yet | ❌ P2 |
| Per-profile extensions registry | ✅ | ❌ | ❌ P2 |
| TOTP 2FA per profile | ✅ | ❌ | ❌ P2 |
| Portable profile bundles (cross-machine) | ✅ (needs os-crypt wiring) | ❌ | ❌ P2 |
| xlsx import, trash/undo | ✅ | ❌ | ❌ P3 |
| socks5 upstream proxies | ✅ | ❌ refused loudly (PROXY_UNSUPPORTED), never bypassed | ❌ P2 |

### P0 — the proxy leak (found in this audit 2026-11-10, FIXED v0.12.0)

`fury-core.runtime.ts` used to build `engineArgs` with no `--proxy-server` at
all; `request.proxyUrl` was accepted and silently dropped. A profile
configured with a proxy browsed on the operator's real IP — the single worst
failure mode this product can have. Fixed and **proven live**:
`npm run verify --workspace apps/api -- --engine fury --proxy` routes the
probe through a recording fake upstream; the `egress-via-proxy` claim PASSes
(credentials injected by the relay, zero bypass). 16/17 claims hold with
proxy on (`uach-consistent` honestly skipped — a LAN-HTTP page is not a
secure context; covered by the standard loopback run).

Fix shape (AliasMode's proven pattern, re-implemented):
1. Auth-injecting loopback relay
   (`apps/api/src/application/runtime/proxy-relay.ts`): per-session, binds
   127.0.0.1 only; the engine gets `--proxy-server=http://127.0.0.1:<port>`;
   the relay injects `Proxy-Authorization` (Chromium strips credentials from
   the flag). Fails closed: upstream refusals reach the client verbatim.
2. `fury` refuses to launch with a proxy the relay cannot honor — loud
   PROXY_UNSUPPORTED (socks5 today), never silent direct.
3. Verification: `egress-via-proxy` in the verify runner (`--proxy` mode) —
   the probe page is served on the LAN IP, a recording upstream must see the
   request with the injected credential, or the run exits 1.

---

## 3. Workflow parity (Jancy ideas — no code exists to copy)

| Capability | Status |
| --- | --- |
| Profiles via CSV / Google Sheets | ✅ |
| Proxy providers + rotation | ✅ |
| Tab ops (open/close/related) | ✅ |
| Scripting against live profiles | ✅ `queuepilot script` |
| Playwright/Puppeteer attach helpers | ✅ |
| Resolver registry (captcha etc.) | ❌ the moat gap |
| Parser registry (per-site extractors) | ❌ the moat gap |
| Plugin system | ❌ |
| Warmup recorder | ❌ |
| Console UX depth (bulk ops, search, health badges) | 🟡 vanilla dashboard now; React migration per ADR-0005 |

---

## 4. Ordered next tasks (each ships as its own commit)

1. ~~**P0 proxy leak fix**~~ — DONE v0.12.0 (relay + refuse-loudly +
   `egress-via-proxy` live proof)
2. **P4c own build** — fetch/apply/build per `engine/README.md`, verify
   harness + claim suite on OUR binary, publish manifest
3. **Claim coverage sweep** — WebRTC (P1), audio, fonts, WebGPU, battery,
   media devices, client rects, scrollbar
4. **Lifecycle P1s** — admission slots, window-fit, session bundles
5. **React console** (ADR-0005) once workflow features need the depth

Every task ends with the green gates in §0. No gate, no commit.
