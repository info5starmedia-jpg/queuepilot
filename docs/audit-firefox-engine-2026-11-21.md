# Audit: aliasmode/aliasmode-firefox — relevance to QueuePilot's "Firefox engine" decision

**Date:** 2026-11-21 · **Scope:** research only, no code · **Method:** GitHub API, repo files, upstream issues, third-party detection-test reports

---

## 1. Project overview

| Fact | Value |
|---|---|
| Repo | https://github.com/aliasmode/aliasmode-firefox |
| What it is | The browser engine behind "AliasMode" (a free, open-source antidetect browser by the Xreacher team). A rebranded/extended fork of **Camoufox** with AliasMode-app integration patches. |
| License | **MPL-2.0** (engine); the AliasMode app is Apache-2.0 |
| Created | 2026-09-21 (very young — ~2 months old) |
| Stars / forks / open issues | **6 stars**, 1 fork, **0 open issues** (1 closed issue, a README rewrite) |
| Language | Python (build/packaging tooling; the actual engine is a patched Firefox C++ tree) |
| Last push | 2026-11-20 (active) |
| Release cadence | 10 runtime releases between 2026-10-19 and 2026-11-06: `aliasmode-runtime-156.0.1-beta.36-r5` … `-r14`, i.e. roughly every 2–4 days, all on the same Firefox base |
| Base | **Camoufox v156.0.1-beta.36**, pinned in `settings/aliasmode-provenance.json` (source revision `7a4ac0d…`). The build runs on Linux; Windows/macOS cross-compiled. ~70 patch files under `patches/`, including patch sets imported from LibreWolf and Ghostery, plus a Playwright **Juggler** integration (`patches/playwright/`) |

**Interpretation:** the project itself is a thin, brand-new, low-traction wrapper. The real substance — and the real dependency — is upstream **daijro/camoufox** (13,513 stars, 79 open issues, pushed 2026-11-19, MPL-2.0). AliasMode Firefox = Camoufox + app-integration patches (canvas-noise audit fixes, tab handling, WebSocket/response-body reporting for the app, keep-alive-after-last-window).

## 2. Stated goals and fingerprint-vector coverage

README (`README.md`) and `ROADMAP.md` state: engine-level (C++) spoofing, "pages cannot see it, hook it, or detect a patched API," with every patch public under `patches/`. Vectors covered, per patch files:

- **Navigator/screen:** `navigator-spoofing.patch`, `screen-spoofing.patch`, `screen-workarea-baseline.patch`, `touchscreen-fingerprint-spoofing.patch`, `window-screen-position.patch`, `window-setter-seal.patch` (UA, platform, hardwareConcurrency, touch points, screen/window geometry)
- **WebGL:** `webgl-spoofing.patch`, `webgl-stated-limits.patch`, `webgl-unmasked-renderer-and-readback.patch` (vendor, renderer, parameters, extensions)
- **Audio:** `audio-context-spoofing.patch`, `audio-fingerprint-manager.patch`, `audio-noise-on-copy.patch` (AudioContext output, sample rate)
- **Fonts:** `anti-font-fingerprinting.patch`, `font-list-spoofing.patch`, `font-hijacker.patch`, `font-system-fonts-css2.patch`, `glyph-advance-noise.patch`, `system-ui-font-spoofing.patch`, `web-font-lookups.patch`, `font-pack-dir.patch` (font list, CSS system fonts, per-OS metrics; `docs/FONTS.md`)
- **Network-adjacent:** `webrtc-ip-spoofing.patch`, `webrtc-proxy-ice-agent.patch`, `webrtc-port-range.patch`, `geolocation-spoofing.patch`, `timezone-spoofing.patch`, `locale-spoofing.patch`, `network-ipv4-only.patch`, `network-patches.patch`, `stable-browsing-session-key.patch`
- **Canvas:** `canvas-readback-noise.patch` — November commits ("Key the canvas encode hash by the profile seed, not a per-launch UUID", grey-pixel handling) show active hardening of canvas noise
- **Media:** `media-codec-spoofing.patch`, `media-device-spoofing.patch`, `speech-voices-spoofing.patch`, `voice-spoofing.patch` (`docs/MEDIA-DEVICES.md`)
- **Automation stealth:** `playwright/0-playwright.patch` + `1-leak-fixes.patch`, `debugger-invisible-to-content.patch`, `trusted-automation-events.patch`, `focus-events-stock.patch`, human-like cursor (`additions/juggler/input/CursorTrajectory.js`), `no-css-animations.patch`
- **Privacy/compile-time:** LibreWolf patch set (`disable-data-reporting-at-compile-time.patch`, etc.), Ghostery patches, `no-search-engines.patch`, `pin-addons.patch`

**Patch depth:** genuinely C++ engine patches applied to the Firefox source tree (see `docs/patch-upgrading-guide.md` — a documented rebase workflow for when Firefox bumps break hunks), with per-Playwright-context support built into each patch (MaskConfig, manager classes, `Window.webidl` setters). This is not JS injection.

**Notably absent:** nothing touches **TLS/JA3/JA4 or HTTP/2**. That is by design — the engine *is* Firefox (NSS stack, genuine Firefox ClientHello), so network-layer fingerprints are authentic Firefox rather than spoofed. (Camoufox issue #778, "TLS ClientHello doesn't match Mozilla's official Windows builds while the default persona is Windows," was a consistency bug, now closed.)

**Roadmap gaps the maintainers admit** (`ROADMAP.md`, no dates, "ships when tests prove it"): fonts/voices/WebGL parameters/permissions/WebRTC capabilities/audio hashes not yet drawn from the fpgen identity model; reproducible identities across relaunches in progress; per-context fonts incomplete; WebAuthn/audio-device platform-consistency open; automation protocol resilience (runaway `evaluate`, dead Juggler pipe); sandbox support (gVisor); several macOS/Windows platform polish items; CI does not test packaged builds with langpacks.

## 3. Bugs, limitations, and detection-test results

**Maintainer-admitted / upstream issues of note** (daijro/camoufox):
- #1037 (open) — Akamai Bot Manager on fedex.com detects Camoufox
- #955 (closed) — DataDome device check (`rt='i'`) distinguished Playwright-driven Camoufox from uninstrumented Firefox (fixed)
- #778 (closed) — Windows-persona TLS ClientHello inconsistency vs. Mozilla official builds
- #1060 (open) — memory not released after navigation with uBlock Origin
- #962 (open) — Firefox auto-update handling
- #686 — a long-running "Detection status by site" tracking issue

**Third-party detection tests (Camoufox, which AliasMode Firefox tracks):**
- ScrapingBee guide (2026-09-17, Camoufox 0.5.6 / Firefox 152, controlled vs. stock Playwright Firefox on same IP): **CreepJS headless 0%** (stock: 33%), **BrowserScan 0 automation flags** (stock flagged "WebDriver: Robot"), TLS fingerprint **identical to stock Firefox**, BrowserScan authenticity **75–80%** through a US residential proxy, Cloudflare Turnstile (NopeCHA demo + Crunchbase) passed. → https://www.scrapingbee.com/blog/how-to-scrape-with-camoufox-to-bypass-antibot-technology/
- Other 2026 writeups report 0% CreepJS/BrowserScan in controlled tests (Zylos Research, 2026-04; RoundProxies, 2026-01); one wrapper (mcp-camoufox) cites a 6% CreepJS stealth score.
- General consensus across 2026 sources: Camoufox passes JS-layer and fingerprint-suite checks; residual failure modes are TLS/HTTP-2-adjacent bot managers (DataDome, Akamai, Kasada) and IP reputation — the same wall patched-Chromium stacks hit.

**AliasMode's own testing:** an elaborate in-house "stealth grade" harness (`build-tester/` — 15+ categories incl. automation detection, JS-engine signals, lie detection, canvas/WebGL/audio, cross-signal consistency; A ≥ 95%) runs in CI, but per `AGENTS.md`, per-vector stealth detail is deliberately **not public** (`ci/run_sundial.py` "reports a grade and a count; the vectors never leave that module"). No public CreepJS/BrowserScan/Pixelscan/sannysoft scorecard exists in the repo.

## 4. Firefox-engine vs. patched-Chromium: vector differences and dual-engine cost

**Fundamentally different vectors (a Firefox engine cannot be mimicked from Chromium):**
- **TLS/JA3/JA4:** Firefox uses NSS; Chromium uses BoringSSL. Cipher suites, extensions, and ClientHello shape differ structurally. A Chromium patch can only reorder within BoringSSL's envelope — it cannot produce a genuine Firefox JA3/JA4. This is the single biggest evasion delta.
- **HTTP/2 (and HTTP/3):** different network stacks (NSS/necko vs. Chromium's) → different frame ordering, priority, SETTINGS.
- **JS-engine quirks:** SpiderMonkey vs. V8 — `Function.prototype.toString`, error-stack formats, `Math`/`Number` edge cases, `Intl` behavior, date parsing. These leak the engine regardless of navigator spoofing.
- **API surface:** Chrome-only APIs (WebBluetooth, WebUSB, WebSerial, File System Access, `chrome://` branding, PWA install flows) are absent in Firefox; Firefox has its own API deltas. Personas must be engine-coherent — you cannot sell a "Firefox" UA from a Chromium core.
- **Font/text rasterization and CSS layout:** different renderers → different canvas/text metrics and CSS feature probes.
- **Automation channel:** Camoufox/AliasMode drives Firefox via Playwright's **Juggler** protocol (patched into the engine), not CDP. QueuePilot's CDP-based scripting/AI-assistant stack would need a second driver path.

**Cost of maintaining two engines (evidence from this repo):**
- Firefox releases monthly; each bump risks breaking ~70 C++ patches. The repo ships a `watch-camoufox.yml` daily CI watchdog that *fails on purpose* when upstream moves to a newer Firefox, plus a `docs/patch-upgrading-guide.md` devoted entirely to fixing patch rejects per version bump. This rebasing treadmill is the standing cost of a Firefox engine.
- AliasMode itself lags upstream: it ships Firefox **156.0.1** while Camoufox is already at **159.0-beta.42** (2026-11-15) — a 3-major-version gap after ~1 month.
- Test-matrix duplication is real: this repo carries parallel Python and TypeScript test suites, native pytest harnesses, and per-patch regression tests.
- **Precedent:** AliasMode already runs exactly this dual-engine model — `aliasmode-chromium` (Chromium 155, built on "Apostate") + `aliasmode-firefox` (Camoufox), engine chosen per profile in the app. It is viable, but it is a team-sized commitment, not a feature branch.

## 5. Camoufox upstream health

- **Very healthy:** 13.5k stars, pushed within the last 48h (2026-11-19), release cadence of roughly **one beta every 1–2 weeks** (v156.0.1-beta.36 Oct 15 → v158.0-beta.40 Oct 19 → v158.0.1-beta.41 Oct 29 → **v159.0-beta.42 Nov 15**, plus font-bundle releases), tracks current Firefox closely, 79 open issues with active triage, sponsored by multiple proxy vendors (a funding signal).
- Risk profile is the inverse of a self-maintained fork: the Firefox engine goes stale fast *only if you own the patches*. Consuming Camoufox as a pinned, watched upstream dependency (the AliasMode pattern) transfers that risk upstream.

## 6. Bottom-line recommendation for QueuePilot

**Does a Firefox engine meaningfully expand evasion? Yes — but specifically as a second, genuinely-different network/JS identity.** The value is not "another browser"; it is a **different JA3/JA4 + HTTP/2 stack + SpiderMonkey surface** that a patched Chromium 159 physically cannot emit. For multi-accounting, Firefox profiles are unlinkable from Chromium profiles at the TLS layer, and the Firefox TLS fingerprint is authentic rather than impersonated. The JS-layer vector set (navigator, canvas, WebGL, fonts, audio, screen) is largely duplicative of what QueuePilot already spoofs — that half is mostly redundant effort.

**Recommended path — conditional yes, consume don't fork:**
1. **Do not write your own Firefox patches.** Adopt Camoufox (MPL-2.0, commercial use permitted) as a pinned upstream engine dependency — exactly the AliasMode model: pin a provenance revision, add a watchdog for upstream Firefox bumps, ship rebased binaries per upstream beta.
2. **Gate the investment on your automation stack's portability.** The hard prerequisite is Playwright/Juggler driver support alongside your CDP stack. If QueuePilot's scripting and AI assistant are CDP-locked, budget for a second driver abstraction first — that, not fingerprinting, is the make-or-break cost.
3. **Expect a permanent rebase treadmill** (monthly Firefox cadence → patch/test churn, historically a 3-version lag even for a dedicated team). Price 1–2 engineers ongoing, or accept shipping engine updates lagging upstream by weeks.
4. **Firefox profiles should be offered as a distinct persona family** ("engine: firefox"), never mixed with Chromium personas — cross-engine consistency is where dual-engine products get detected.
5. If the goal is merely more fingerprint diversity within one engine, a Firefox engine is **not** worth it — the duplicative JS-layer work outweighs the gain. It pays off only when targets fingerprint TLS/JA4/HTTP-2 or correlate accounts across engine families.

**Verdict:** Worth it only as a *second engine* sourced from the healthy Camoufox upstream, and only if QueuePilot can abstract its automation layer over both CDP and Juggler. Otherwise it is duplicative effort with a high, permanent maintenance cost.
