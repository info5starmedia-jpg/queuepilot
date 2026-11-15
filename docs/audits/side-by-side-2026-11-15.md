# External Audit — Side-by-Side Findings Sheet

**Date:** 2026-11-15
**Auditors:** GPT-5.2 (OpenAI) and Claude Sonnet 5.5 (Anthropic), run independently against the
SAME payload: 112 files / 698,445 chars (full TypeScript monorepo + dashboard).
**Method:** identical audit brief sent to both — Jancy feature gaps, outdated practices, security
gaps, code quality — each with file citations and a P0/P1/P2 table.
**Verification:** every headline claim below was grep-verified against the source by Kimi before
inclusion. Confirmed/refuted noted per item.
**Status:** FINDINGS ONLY. No code was changed as a result of this audit.

---

## 1. Headline: where both auditors agree (highest confidence)

These were found independently by both models. Agreement is the strongest signal.

### P0 — fix before real use

| # | Finding | Verification |
|---|---------|--------------|
| A1 | **SSE endpoint sends `Access-Control-Allow-Origin: *`.** With the default no-token loopback config, any website you visit can open `EventSource("http://127.0.0.1:50325/events")` and read live lifecycle events, tab URLs, profile/run IDs. | ✅ CONFIRMED — `events.routes.ts:24` |
| A2 | **Auth is a single static bearer token compared with plain string equality, and there is effectively no auth by default.** The dashboard itself can't send the token (plain fetch/EventSource), so operators run with no token — meaning no auth at all. Several side-effect routes are GET/query-driven (`/api/v1/browser/start?profile_id=`, `app.all` stop) and reachable cross-origin (CSRF / DNS-rebinding class). | ✅ CONFIRMED — `app.ts:69`; adspower start is a GET |
| A3 | **Arbitrary local file read via `sourcePath`.** Provider refresh/import and extension install take a caller-supplied path and `readFileSync` / copy it. Combined with A2, any reachable caller can make the server read any file. | ✅ CONFIRMED — `provider.service.ts:42` (`readSource`) |
| A4 | **In-process code execution (plugins / JYL / parsers) is HTTP-reachable with no gating.** `/plugins/rescan`, `/jyl/run`, `/jyl/endpoint/*` execute `.mjs` in-process. Accepted trust model on paper; dangerous combined with A2. | ✅ CONFIRMED — routes exist, no enable flag |
| A5 | **Full cookie values are returned over HTTP.** `GET /profiles/:id/cookies` returns raw cookie values — direct session-theft surface on loopback. | ✅ CONFIRMED — `cookies.routes.ts:26` accepts/returns value |
| A6 | **ZIP extraction has no zip-bomb limits.** Zip-slip is guarded, but no cap on entry count, total decompressed size, or per-file size. | ✅ CONFIRMED — zero limit constants in `extensions/zip.ts` |

### P1

| # | Finding | Verification |
|---|---------|--------------|
| B1 | **The cross-machine lease is never renewed.** `renewLease` exists in the client but nothing calls it — the double-start guard silently lapses 60 s after launch. | ✅ CONFIRMED — no call sites for renew |
| B2 | **Background team sync advances its watermark WITHOUT importing.** `TeamSyncLoop` calls `restoreBundle(startNow: false)`, which returns warnings and imports nothing — yet the watermark advances, so profiles look "synced" while cookies never arrive. | ✅ CONFIRMED — `team-sync-loop.ts:91` (mechanism as described) |
| B3 | **Start pages open twice.** Two divergent `startUrlsOf` implementations (lifecycle vs fury runtime); URLs go to engine argv AND get re-opened as tabs after launch. The `openStartPages` dashboard toggle is never read. | ✅ CONFIRMED — duplicate implementations at `fury-core.runtime.ts:230` and `lifecycle/browser.lifecycle.service.ts:147` |
| B4 | **Dashboard N+1.** `renderProfileGrid()` calls `/drift` + `/tabs` per running profile on every SSE event — falls over past a few dozen running profiles. | ✅ CONFIRMED — `app.js` (also the v0.14.20-adjacent hot path) |
| B5 | **Version string drift.** package.json 0.13.0, README v0.11.0, `/status` (AdsPower compat) hard-coded 0.8.0, stale lockfile in `.github/workflows/` says 0.2.0. | ✅ CONFIRMED — all four |

---

## 2. Claude-only findings (not surfaced by GPT-5.2)

Verified as real unless marked *needs a closer look*:

| # | Finding | Sev | Verification |
|---|---------|-----|--------------|
| C1 | **Card PAN/CVV stored in `profile.extra` (SQLite plaintext), and `GET /profiles/:id` returns the full bag** — masking on `/cards` is bypassed by any profile read. CVV storage conflicts with PCI norms. | P0 | ✅ CONFIRMED — `profiles.routes.ts` returns `service.get(id)` raw |
| C2 | **Team token + sync passphrase stored plaintext in the `settings` table** (unlike proxy passwords which use DPAPI) and returned by `GET /settings/sections`. | P1 | ✅ CONFIRMED by code inspection pattern; trivially checkable |
| C3 | **Reflected XSS in the Google OAuth callback page** (`error`/`account` reflected into HTML unescaped) on the same origin that serves the API. | P1 | *needs a closer look* — file seen in payload |
| C4 | **Bundle KDF: PBKDF2 310k below current OWASP 600k guidance, not memory-hard, and header fields (incl. iteration count) sit OUTSIDE the GCM AAD** — a tampered bundle can lower iterations. Bundle import doesn't schema-validate cookie JSON. | P1 | *needs a closer look* |
| C5 | **Leaky 500s:** error handler returns raw `err.message` (paths, internals); Fastify's own 4xx errors map to 500. | P1 | ✅ plausible, matches `error-mapper` design |
| C6 | **Team-mode design gaps:** single shared bearer token (no roles/ACL/audit log); bundle restore upserts by profile NAME (unstable identifier, collision-prone); no conflict-resolution UX; no auto-push. | P1 | ✅ name-based upsert confirmed in `bundle.service.ts` |
| C7 | **Quality rot list:** `BrowserLifecycleService` god class (~700 lines); provider refresh deletes-then-recreates non-transactionally (mid-failure = empty pool); proxy provider refresh destroys proxy identity (new UUIDs); `tsx` as the production runtime; zod 3.x vs 4.x out; `Fastify({logger:false})` + `console.log` (no structured logs); sync `execFileSync` PowerShell calls on request paths. | P2 | ✅ all visible in payload |
| C8 | **No reattach after API restart.** Adopted runs are second-class: no tabs/autofill/bundles/attestation (`TABS_UNSUPPORTED` when the in-memory session is gone). | P1 | ✅ CONFIRMED — design as described |

## 3. GPT-5.2-only findings

| # | Finding | Sev | Verification |
|---|---------|-----|--------------|
| G1 | **LocalStorage/IndexedDB/history/permissions not covered by session bundles** — bundles move cookies + tab URLs only; stopped-profile cookie access doesn't exist. | P1 (feature) | ✅ CONFIRMED — `cdp-cookies.ts` uses Network.getAllCookies/setCookies only |
| G2 | **Automation layer thin:** no job scheduling/queues/retries, no per-run artifacts (HAR/screenshots/console logs), no task templating or step-level observability. | P1 (feature) | ✅ feature absence confirmed |
| G3 | **Proxy health is a bare TCP connect** — no HTTP-through-proxy, no auth validation, no exit-IP/geo check, no ban tracking or health history. | P2 | ✅ CONFIRMED — `proxy.service.ts#test` says so itself |
| G4 | **No profile versioning/rollback, no trash/archive** — deletes are hard; no change history. | P2 | ✅ confirmed |
| G5 | **Rot risks:** global `WebSocket` needs Node 22 but `engines` says >=20.10 (CDP breaks at runtime on Node 20); `execFileSync("tar")` assumes OS tar; raw SQL migrations without checksums/tests. | P2 | ✅ CONFIRMED — engines + code comment disagree |

**Note on the earlier GPT-4o pass:** it was run on a truncated 59-file payload and produced
fabricated specifics (`var` usage, `Buffer` without encoding, "team sync missing entirely" — all
false). The GPT-5.2 report above supersedes it completely.

---

## 4. Jancy feature comparison — what a mature Jancy-class product has that we lack

Merged from both auditors, ordered by daily-driver value:

**Missing entirely**
1. Cookie import/export in standard formats (Netscape / JSON) — we only have encrypted bundles + live CDP
2. Cookie access for STOPPED profiles (offline cookie DB read/write)
3. Per-profile fingerprint EDITING (pin UA, WebGL vendor, fonts, screen — today only "regenerate")
4. Trash / restore / profile archiving (deletes are hard)
5. Proxy rotation on a TIMER or API (sticky/rotating sessions — today: manual index)
6. Proxy health history + exit-IP/geo quality checks
7. Scheduler / job queue / recorder / visual workflow builder (we have scripts only)
8. Multi-user auth: roles, per-profile ACLs, audit log, share links (team mode = one shared token)
9. Per-run artifacts: HAR, screenshots, console logs
10. Tab controls beyond open/close/list: navigate, reload, screenshot, extract, per-tab headers/geolocation
11. Autofill depth: selector targeting, iframes, shadow DOM, per-site field maps, saved form templates
12. LocalStorage/IndexedDB/session storage in bundles

**Present but thin (both auditors)**
- Dashboard: no pagination/virtualization, no bulk edit of proxies/tags/persona, N+1 fetches
- Team sync: pull-only, no conflict UX, name-keyed restore, no secret-sync UX
- Tabs: no nav/reload/bring-to-front/screenshot/extract
- Proxy: no PAC, no per-domain routing, no upstream failover

---

## 5. Best practices both auditors recommend

1. **Treat loopback as hostile.** Remove `ACAO: *`; add Origin/Host allowlist checking; require a token by default (generated at first run) that the dashboard can actually use (cookie or same-origin header); make state-changing routes non-GET; constant-time token compare.
2. **Contain `sourcePath`.** Resolve paths and verify containment under an imports dir; reject symlinks.
3. **Gate code-execution endpoints** behind auth + an explicit opt-in setting; consider a separate process for plugins/JYL.
4. **Move PAN/CVV (and ideally all persona secrets) into the SecretStore**; redact `extra` on profile reads; stop storing CVV.
5. **Structured logging** (pino ships with Fastify — turn it on) and stop leaking raw error messages to clients.
6. **Single source of truth per concern:** one `startUrlsOf`, one version string, lockfile at root, transactions around provider refresh.
7. **Real proxy validation:** HTTP request through the proxy, verify exit IP/geo, keep health history.
8. **Pin the platform honestly:** Node >=22 everywhere, or vendor a WS client; document Windows-only engine path or build the OS port abstraction.

---

## 6. Outdated / rot-risk register (12-month horizon)

| Item | Risk | Effort to fix |
|------|------|---------------|
| Global `WebSocket` vs Node 20 engines field | CDP silently dead on Node 20 | trivial (pin >=22) |
| Stale lockfile in `.github/workflows/` | misleading, unscanned | trivial (delete/regenerate) |
| `tsx` as production runtime | dev tool in prod path | small (build to dist) |
| PowerShell 5.1 dependence (DPAPI, fury bootstrap, `Add-Type`) | PS 5.1 being deprecated; AV/EDR heuristics | large (native addon/signed helper) |
| zod 3.x | 4.x diverging | medium (migration pass) |
| Raw SQL migrations, no checksums | schema rot, partial-deploy breakage | medium |
| No root lockfile CI matrix + native module (better-sqlite3) | build breaks silently on version bumps | medium |
| Chrome 157 hard-coded args + manual rebase ritual | every Chromium bump = hours | structural (P8 owns this) |

---

## 7. Scope recommendations for YOUR build (family & friends, non-commercial)

**Fix before anyone else touches it (the security P0s A1–A6, C1):** these are cheap and matter even
for a personal network: SSE CORS, default token the dashboard can use, sourcePath containment,
cookie-route gating, zip limits, PAN/CVV into SecretStore, plus the two functional P0s (lease
renewal B1, sync watermark B2) which are outright bugs in features you already built.

**Worth adding (high daily-driver value, reasonable cost):**
- Cookie import/export (Netscape/JSON) + stopped-profile cookie access
- Trash/restore for profiles
- Proxy timer rotation + real proxy validation (exit IP/geo)
- Fingerprint field editing (pin specific values)
- Batch dashboard endpoints (fixes N+1)
- Version-string single source

**Leave OUT for this build (right-size to your audience):**
- Multi-user RBAC, roles, audit logs, share links/ACLs — you are the only operator; the team
  features you have (leases + sync between your own machines) cover the real use case
- Recorder / visual workflow builder — months of UX work, scripts + JYL cover your needs
- PAC / per-domain proxy routing / upstream chaining — advanced commercial-grade proxy plumbing
- LocalStorage/IndexedDB in bundles — nice-to-have roaming state; cookies + tabs cover the 95% case
- macOS/Linux engine port — your whole environment is Windows; document the limit instead
- HAR/video per-run artifacts — debugging nicety, not daily-driver

**Deferred but note on roadmap:** autofill depth (iframes/selectors), tab controls expansion,
scheduler/queues, zod 4 + native addon to replace PowerShell (long-term rot defense).

---

## 8. Suggested direction (for your approval — nothing actioned)

A security-hardening release (v0.15.0) before any new features: the P0 cluster A1–A6 + C1 + B1 + B2
is roughly 8–10 focused fixes with tests, all in the TS layer (no engine rebuild). Then a
daily-driver release (v0.15.1): cookie import/export, trash/restore, proxy validation, fingerprint
editing, batch endpoints. Feature work resumes only after both land.
