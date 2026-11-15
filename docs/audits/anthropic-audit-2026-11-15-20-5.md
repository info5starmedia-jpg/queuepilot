# anthropic external audit — 2026-11-15T20:52:27.095Z

_provider model: claude-sonnet-5-5 · 112 files / 698445 chars sent_

# QueuePilot Audit

**Scope note.** The upload was truncated: `.github/workflows/package-lock.json` is cut off, and the shared `contracts` source, `apps/server`, `packages/client`, and most of the test suite weren't visible. Findings below cover what I could read. Where I infer something from an unseen file, I flag it.

---

## 1. Jancy feature gaps

**Present and solid:** profile CRUD, groups/folder tabs, tags, clone (with fresh fingerprint), batch start/stop/move/tile, favorites and tab colors, CSV and Google Sheets import, proxy providers with distribution modes, per-profile proxy lists with rotation, temp proxies, tabs with isolated CDP browser contexts, Tab Thinger query language, cookie surgery, encrypted session bundles, team lease and sync, extensions registry, TOTP, resolver, parser and plugin registries, JYL commands and macros, window tiling, and an AdsPower-compatible API.

**Missing entirely**

| Gap | Notes |
|---|---|
| Cookie import/export in standard formats (Netscape, JSON) | Only the encrypted bundle and CDP load exist. |
| Per-profile fingerprint editing | The only controls are "regenerate" and platform. Users can't pin UA, WebGL vendor, fonts, or screen. |
| Roles, permissions, audit log | Team mode is a single shared bearer token. |
| Profile transfer/sharing UX | Bundles exist but there is no share link, ACL, or per-profile access. |
| Recorder, visual workflow builder, scheduler | Automation is scripts only. |
| Proxy rotation on a timer or API (sticky and rotating sessions) | Rotation is manual via an index. |
| Proxy health history, geo/IP-quality checks | `ProxyService.test` is a bare TCP connect and says so in its own comment. |
| Trash/restore and profile archiving | Deletes are hard. |
| Cross-platform engine support | See §4. |
| Cross-platform secret protection | See §3. |
| Multi-user web console auth (login, sessions) | The only gate is a static bearer token. |

**Present but thin**

- **Dashboard.** Vanilla JS with no pagination or virtualization. `renderProfileGrid` fetches `/drift` and `/tabs` per running profile on every SSE event, so it won't scale past a few dozen running profiles.
- **Team sync.** Pull-only in the background. Pushes are manual, there is no dirty-tracking, and the sync cursor is per-machine.
- **Cookie scope.** Cookie import/export covers the live engine only. Nothing reads or writes cookies for a stopped profile.
- **Proxy support.** socks5 works via the relay, but there is no PAC, no per-domain routing, and no upstream-chain failover.
- **Tabs.** Fine for the Fury and Camoufox runtimes. `TABS_UNSUPPORTED` is returned honestly elsewhere.

---

## 2. Outdated practices

- **`better-sqlite3 ^13.0.3`** in package.json against a lockfile pinned at 11.10.0 (the lockfile also says `@queuepilot/api@0.2.0`). The lockfile lives in `.github/workflows/`, where npm won't read it, so no lockfile governs the build. This is a stale artifact with misleading placement.
- **Native-module build fragility.** `better-sqlite3` compiles via prebuild-install. Pairing it with the engine toolchain on Windows and Node ≥ 22 will break on version bumps with no CI matrix to catch it.
- **Chromium handled through string-concatenated PowerShell.** `spawnFuryWithConfig` and `captureWindows` rely on PS 5.1 quirks (BOM, `-File`, handle masking). Microsoft is deprecating Windows PowerShell 5.1, so this is a hard rot candidate.
- **`Add-Type` P/Invoke in the launch script.** Same story: AV-hostile and brittle across PS versions.
- **Node global `WebSocket` for CDP** (`cdp-connection.ts`): `engines.node >=20.10` in the root package.json, but global WebSocket is stable only from Node 22. On Node 20 `new WebSocket` is undefined and every CDP feature fails at runtime. The comment in the file even says "Node >= 22".
- **Browser/engine launch args hard-coded for Chrome 157** and a pinned Fury patchset, with a manual "rebase ritual". Each Chromium bump costs hours of work and builds that take 6–12 hours.
- **`execFileSync` PowerShell calls** in `process-inventory.ts`, `host-display.ts`, and `secret-store.ts` block the event loop for ~100 ms each and are called on request paths (proxy CRUD, launch).
- **`tsx` as the production runtime** (`"start": "tsx src/main.ts"`). That's dev tooling, and it adds a transpile step on every start.
- **zod 3.x**, with 4.x out and diverging in API and errors.
- **`Fastify({ logger: false })`.** No structured logging anywhere; `console.log/warn` is used instead.

---

## 3. Security gaps

| Sev | Finding |
|---|---|
| **High** | **Auth is bypassable with a non-token path and a timing-unsafe check.** `req.headers.authorization !== \`Bearer ${token}\`` is a plain string comparison. The `/health` exemption is exact-match on `req.url`, so `/health?x=1` is not exempt but is also not special. The bigger problem is that the **dashboard (`/`, `/dashboard/*`) and `/events` are behind the same hook**, but the dashboard JS makes plain `fetch`/`EventSource` calls with no Authorization header, so with a token set the console is unusable. Operators will leave the token unset, which means no auth at all. |
| **High** | **No auth by default plus permissive SSE CORS.** `/events` sends `access-control-allow-origin: *`. With the default no-token loopback config, any web page the operator visits can `EventSource("http://127.0.0.1:50325/events")` and read lifecycle events. And since there is no CORS preflight handling and `POST` with `Content-Type: application/json` triggers preflight, state-changing routes are partially protected only by that accident. `text/plain` bodies hitting Fastify's JSON parser are rejected, but `/api/v1/browser/start?profile_id=` (GET) and `/api/v1/browser/stop` (`app.all`, query-driven) are CSRF/DNS-rebinding reachable. A malicious page can start and stop profiles. No Host/Origin check exists. |
| **High** | **Arbitrary local file read via `sourcePath`.** Provider routes and `readSource` take a user-supplied path and `fs.readFileSync` it. Combined with the above reachability, any caller can make the server read arbitrary files and the parse errors or imported rows can leak contents. The same applies to `extensions` install (`sourcePath` to copy any directory into the profile) and to the settings bundle. |
| **High** | **Plugin/JYL/parser code execution with no gating.** `import(pathToFileURL(file))` executes anything in the data dir in-process. The docs accept this as the trust model. But `/plugins/rescan`, `/jyl/run`, and `/jyl/endpoint/*` are HTTP-reachable, so any reachable unauthenticated caller combined with a writable data dir gets code execution. |
| **High** | **Proxy credentials and persona secrets in plaintext on non-Windows, and weakly gated everywhere.** `createSecretStore` throws on non-Windows unless `QUEUEPILOT_SECRET_STORE=plaintext`, so macOS and Linux users are pushed to plaintext. On Windows, DPAPI stops other users but not same-user malware, which the code correctly states. Pre-P6 rows migrate lazily on read only. |
| **High** | **Full PAN/CVV stored in `profile.extra` (SQLite plaintext).** Card numbers and CVVs are written to the DB in the clear. Masked reads exist, but the storage of record is the raw bag, and CVV storage after authorization conflicts with PCI-DSS norms. The profile CSV import also carries them, and settings bundle export excludes them but the **session bundle manifest copies `notes` and `tags`**. |
| **Med** | **`/profiles/:id/cards` is masked but `GET /profiles/:id` returns the full `extra` bag**, which includes card numbers, CVV, SMS numbers, passcodes, and `extra.fields` literal passwords. Masking is bypassed by any profile read. |
| **Med** | **Expression injection surface in CDP evaluate.** Values are JSON-inlined, which is safe against quote breakouts. U+2028/2029 are valid in JS strings since ES2019, so it's fine. But `buildTypingExpression` and the others embed user text into scripts executed in third-party pages, and the page can hook `Event`/`dispatchEvent` or the value setter to capture card numbers, CVVs, and typed text. Autofill into attacker-controlled pages is the intended exfil path, and there is no domain allowlist for card fill. |
| **Med** | **Team token and sync passphrase stored in the SQLite `settings` table in plaintext** (`team.token`, `team.syncPassphrase`), unlike proxy passwords. The GET `/settings/sections` response also returns them to any caller. |
| **Med** | **Bundle KDF.** PBKDF2-SHA256 at 310k iterations is acceptable but below the current OWASP figure (600k) and not memory-hard. Bundles carry full cookie jars, so weak passphrases are high-impact. The envelope isn't authenticated as AAD (the header fields, such as the iteration count, sit outside the GCM AAD). An attacker can lower `iterations` in a tampered file to make brute force on a known-passphrase probe trivial, though this requires the passphrase anyway. |
| **Med** | **Bundle import trusts unvalidated cookie JSON.** `openSessionBundle` does `JSON.parse` and a shallow check. A hostile bundle with a valid passphrase can inject arbitrary cookies into any domain in a profile. |
| **Med** | **Per-profile os-crypt key stored beside the data it protects** (`.queuepilot/oscrypt.key`, a 0o600 mode that is a no-op on Windows). This is documented as intentional for portability, but it makes encryption-at-rest of cookies decorative against anyone with file access. The README markets this as "encrypt at rest". |
| **Med** | **Relay** `readHead` has a 64 KB limit but no overall timeout on the client side (slowloris on loopback is low-risk). The relay listens on loopback with no auth, so any local process can use the operator's authenticated proxy. |
| **Med** | **ZIP extractor** guards zip-slip by name but doesn't bound decompressed size (zip bomb), entry count, or symlink entries. Extension install runs on whatever path the caller names. |
| **Low** | **Google OAuth callback reflects `error`/`account` into HTML unescaped** (`google.routes.ts`): reflected XSS on a loopback origin that also serves the whole API. |
| **Low** | **`req.params` interpolated into error messages and a reflected 404 page** are JSON, so fine, but the callback page above isn't. |
| **Low** | `process-start token` fallback returns "alive" on read failure, which is the right bias but makes PID-reuse protection best-effort. |

---

## 4. Code quality

**Architecture**

- **Engine layer is Windows-only in practice.** `fury-core.runtime.ts` shells out to PowerShell and `taskkill`. `host-display.ts` returns null off Windows. The README sells a cross-platform API. A staff engineer would split a `ProcessLauncher` port per OS.
- **`BrowserLifecycleService` is a god class** (~700 lines) mixing launch, tabs, drift, attestation, egress, and start pages. `launchInner` indentation is a leftover from a refactor.
- **Two sources of truth for start pages.** `start-pages.ts` (`startUrlsOf`, zod-validated) and `fury-core.runtime.ts`'s own `startUrlsOf` (loose, with an `about:blank` default) share a name and differ in behavior. The lifecycle also *re-opens* start pages as tabs after launch while the runtime passes the same URLs as engine argv, so pages open **twice**. The dashboard's `Settings → Launch → openStartPages` toggle is never read.
- **`main.ts` composition root has dead and misordered wiring:** `registerGmailResolver` is registered after `ResolverRegistry` is passed around, `jyl`/`extensions` are optional in `AppDeps` with a pile of `if (deps.x)` branches, and the version string in `/status` is hard-coded `0.8.0` against package `0.13.0` and README `0.11.0`.
- **Provider refresh deletes then recreates proxies non-transactionally.** A failure partway through leaves the pool empty. `ProfileProviderService.refresh` also isn't transactional across rows.
- **`ProxyProviderService.refresh` destroys proxy identity on every refresh** (new UUIDs), which would break profile `proxyId` links except that it refuses when any are attached, so the pool can't be refreshed while in use.
- **`proxy.repository` password column** still exists post-P6 and holds plaintext for legacy rows until first read.

**Error handling**

- `app.setErrorHandler` maps unknown errors to a 500 with the raw `err.message` (leaks internals, including filesystem paths from `readSource`).
- Fastify's own errors (malformed JSON, 415) take the same path, so `FST_ERR_*` becomes a 500 "INTERNAL" instead of a 4xx.
- `BrowserLifecycleService.stop` swallows engine-stop errors silently. `fire-and-forget` promises (`void session.exited.then(...)`, `startWindowFit`) have no rejection handling.
- `leaseGuard.release` in `finally` of `start`: if the launch succeeded the lease is kept, but if `session.exited` fires before `stop`, `onEngineExit` never releases the lease, so a crash holds the cross-machine lease until TTL, and nothing renews it, so there is only the 60 s TTL. That is consistent but it means long-running profiles on machine A **lose** their lease after 60 s because **there is no renewal loop** (`renewLease` exists in the client but nothing calls it). The cross-machine double-start guard silently expires a minute after launch.
- The `TeamSyncLoop` conflict policy says "pull-dominant is the honest v1", but pulls call `restoreBundle` with `startNow: false`, which **returns warnings and imports nothing**, while the watermark advances anyway. Background sync therefore marks profiles as synced without importing their cookies.

**Test blind spots** (from what's visible)

- No tests visible for: auth hook behavior, SSE CORS/CSRF, the relay under adversarial input (partial: unit tests unseen), zip-slip/zip-bomb, bundle tamper of KDF params, lease renewal expiry, `TeamSyncLoop` no-op imports, sourcePath file-read exposure, Node 20 WebSocket absence.
- Tests use `FakeBrowserRuntime` with a mock CDP server. No real-engine CI gate exists. The 27-claim suite is manual and Windows-only.
- `vitest` globs and a missing test script for `apps/server` in the shown manifest suggest the daemon is lightly covered. I couldn't see it.

**Hygiene**

- Version drift: package.json 0.13.0, README "v0.11.0", `/status` 0.8.0, lockfile 0.2.0.
- Prettier is in devDependencies and a `format:check` script exists, but no lint (ESLint) step, and the CI workflow wasn't visible.
- `app.js` is a 700-line unmodularized script building HTML via template strings. Escaping is applied via `esc()` mostly, but `data-batch="${esc(p.id)}"` and `href="${esc(...)}"` mixes are easy to regress.

---

## Prioritized findings

| Priority | Dimension | Finding | File(s) | Suggested fix |
|---|---|---|---|---|
| **P0** | Security | No auth by default; token-protected mode breaks the dashboard, so the default is effectively unauthenticated and reachable by any local web page (CSRF/DNS rebinding on GET `/browser/start`, `app.all` stop, `/events` with `ACAO: *`) | `app.ts`, `events.routes.ts`, `adspower.routes.ts`, `dashboard/app.js` | Require a token (generate one at first run); enforce Host and Origin allowlists; remove `ACAO: *`; make GET routes side-effect-free; let the dashboard use a cookie or header token; constant-time compare |
| **P0** | Security | Arbitrary file read and directory copy via `sourcePath` (providers, extensions) | `provider.service.ts`, `extension-registry.ts`, `providers.routes.ts`, `extensions.routes.ts` | Restrict to an imports directory under dataDir; resolve and verify containment; reject symlinks |
| **P0** | Security | Unauthenticated-reachable in-process code execution (plugins, JYL, parsers) | `plugin-registry.ts`, `jyl-registry.ts`, `jyl.routes.ts`, `plugins.routes.ts` | Gate rescan/run behind auth plus explicit opt-in setting; consider worker/vm isolation or a separate process |
| **P0** | Security | Card PAN/CVV and persona secrets stored plaintext in SQLite and returned by `GET /profiles/:id` | `profile.repository.ts`, `profiles.routes.ts`, `persona-fields.ts` | Move PAN/CVV to SecretStore; redact `extra` on reads; stop storing CVV |
| **P0** | Quality | Cross-machine lease never renewed, so the double-start guard silently lapses at 60 s | `team-lease-guard.ts`, `browser.lifecycle.service.ts` | Add a renew timer per live run and release on crash exit; test TTL expiry |
| **P0** | Quality | Background team sync advances its watermark without importing (`startNow:false`) | `team-sync-loop.ts`, `bundle.service.ts` | Import into profile storage without launching, or don't advance the watermark; add a test |
| **P1** | Security | Team token and sync passphrase plaintext in `settings` and returned by GET | `settings.service.ts`, `settings.routes.ts` | Store in SecretStore; write-only API fields |
| **P1** | Security | Reflected XSS in OAuth callback page | `google.routes.ts` | HTML-escape or return plain text |
| **P1** | Security | Bundle: KDF params outside AAD; cookies not validated on import; PBKDF2 below current guidance | `session-bundle.ts`, `cdp-cookies.ts` | Bind header as AAD; schema-validate cookies; raise to 600k or use scrypt/Argon2 |
| **P1** | Security | ZIP extraction unbounded; unsafe entries | `extensions/zip.ts` | Cap total size, entry count, and compression ratio; skip symlinks |
| **P1** | Security | Leaky 500s (raw messages and paths) and Fastify errors mapped to 500 | `error-mapper.ts`, `app.ts` | Map Fastify `statusCode` errors; generic 500 body plus server-side log |
| **P1** | Outdated | `engines.node >=20.10` but global `WebSocket` needs Node 22; no lockfile in the root; lockfile in `.github/workflows/` is stale (0.2.0, better-sqlite3 11) | `package.json`, `.github/workflows/package-lock.json`, `cdp-connection.ts` | Set `>=22`; regenerate and commit the root lockfile; add a CI matrix |
| **P1** | Quality | Windows-only engine path (PowerShell bootstrap, taskkill, DPAPI) under a cross-platform README | `fury-core.runtime.ts`, `secret-store.ts`, `host-display.ts` | Introduce an OS-specific `ProcessLauncher` and SecretStore (Keychain/libsecret); document support honestly |
| **P1** | Quality | Start pages open twice (argv plus `openTab`); `openStartPages` setting unused; two divergent `startUrlsOf` | `browser.lifecycle.service.ts`, `fury-core.runtime.ts`, `start-pages.ts` | Single implementation; one open path; honor the setting |
| **P1** | Jancy gap | No cookie import/export in standard formats; no cookie access for stopped profiles | `cookies.routes.ts`, `bundles/*` | Add Netscape/JSON import-export; read the cookie DB offline or via a headless start |
| **P1** | Jancy gap | Single shared token for team; no roles, ACLs, or audit log | `team-client.ts`, `apps/server` | Per-user tokens, per-profile ACLs, an append-only audit log |
| **P2** | Jancy gap | Proxy rotation timers, health history, and IP-quality checks missing; test is TCP-only | `proxy.service.ts`, `profile-proxies.ts` | Real-request proxy check with exit-IP and geo; scheduled rotation |
| **P2** | Jancy gap | Fingerprint editing limited to regenerate; no scheduler, recorder, or trash/archive | `profile.service.ts` | Add editable identity fields, a scheduler, and soft delete |
| **P2** | Outdated | `tsx` as the production runner; zod 3; PS 5.1 reliance; sync `execFileSync` on request paths | `package.json`, `process-inventory.ts`, `secret-store.ts` | Build to `dist` and run with node; plan the zod 4 move; cache or async the shell-outs |
| **P2** | Quality | `BrowserLifecycleService` god class; non-transactional provider refresh; version string drift (0.8.0 / 0.11.0 / 0.13.0) | `browser.lifecycle.service.ts`, `provider.service.ts`, `adspower.routes.ts` | Split services; wrap refresh in a transaction; single version source |
| **P2** | Quality | Dashboard N+1 fetches per SSE event; vanilla 700-line script; no pagination | `dashboard/app.js` | Debounce and batch endpoints; paginate; modularize |
| **P2** | Quality | Test blind spots: auth, CSRF, relay adversarial input, zip bombs, lease expiry, sync no-op, real-engine CI gate | `tests/*` | Add the listed tests; add a nightly real-engine claim-suite job |
