# 1. SECURITY

## High — Team server bearer auth leaks validity by timing on minted DB tokens
**File:** `apps/server/src/app.ts:45-56`, `apps/server/src/store.ts:92-103`

**Issue:**  
`buildTeamServerApp.authenticate()` hashes the presented bearer token and does a normal SQLite equality lookup for DB-backed tokens (`store.authenticate(token)`), while only the env bootstrap token uses constant-time comparison. That means token validity for minted tokens is determined by ordinary string hashing + indexed lookup, not constant-time verification against a stored secret-derived verifier.

**Exploit sketch:**  
This is only realistically exploitable by a local/network-adjacent attacker with repeated low-jitter measurements against the team server, not over the general internet. They can distinguish “well-formed nonexistent token” from the env admin token path and from DB token hits based on response timing and code paths, which is avoidable for bearer auth.

**Fix:**  
Store a random token ID plus a separate secret verifier, and verify with constant-time comparison after fetching by ID, or keep current opaque token format but iterate candidate hash comparison in constant time for exact-match semantics. At minimum, make DB token auth path mirror the constant-time pattern already used for `adminToken`.

---

## High — Unauthenticated local scripts/plugins/JYL can exfiltrate all operator secrets once scripting is enabled
**File:** `apps/api/src/http/plugins.routes.ts:40-93`, `apps/api/src/http/jyl.routes.ts:17-48`, `apps/api/src/application/jyl/jyl-registry.ts:1-337`, `apps/api/src/application/plugins/plugin-registry.ts:1-209`

**Issue:**  
When `automation.scriptingEndpoints` is enabled, HTTP routes can trigger arbitrary in-process code execution from operator-controlled `.mjs` files with full API process privileges, including `fetch`, secret-backed alias access, Google token use through existing services, filesystem/network access, and live browser control. This is by design for local operator automation, but from a security-review standpoint it becomes a concrete remote-code-execution surface if *any* XSS/CSRF/origin confusion reaches these endpoints. The code relies entirely on bearer token + loopback trust + the setting gate; there is no secondary confirmation, origin check, or capability scoping.

**Exploit sketch:**  
A malicious local webpage cannot hit the API if the bearer token is set and not exposed. But if the API runs without `SPECTRA_API_TOKEN` and the operator has enabled scripting endpoints, a webpage on the same machine can drive `/jyl/run`, `/jyl/endpoint/*`, `/plugins/rescan`, `/parsers/:name/run`, or alias mutation endpoints through normal browser requests, causing local code execution/exfiltration via already-installed modules.

**Fix:**  
Treat scripting endpoints as privileged admin actions:
- Require `SPECTRA_API_TOKEN` whenever `automation.scriptingEndpoints=true`.
- Add an explicit `Origin` / `Sec-Fetch-Site` deny policy for browser-originated cross-site requests.
- Consider a second config gate for code-loading routes (`rescan`, endpoint dispatch) separate from simple parser execution.

---

## Medium — Team server `GET /health` is unauthenticated and leaks operational metadata
**File:** `apps/server/src/app.ts:58-63`, `apps/server/src/app.ts:65-73`

**Issue:**  
`/health` is intentionally excluded from auth and returns `{ ok, name, bundles }`. That exposes server identity and current bundle count to unauthenticated callers.

**Exploit sketch:**  
Any network peer that can reach the server can enumerate whether the team server is up and whether it currently stores synchronized profiles, which is sensitive operational metadata for this product class.

**Fix:**  
Return a minimal unauthenticated health payload (`{ ok: true }`) or require auth for full health details.

---

## Medium — Team sync watermark file writes are not permission-hardened and contain profile sync metadata
**File:** `apps/api/src/application/team/team-sync-loop.ts:53-64`

**Issue:**  
`team-sync-state.json` is written with default filesystem permissions. It contains remote profile IDs, imported revisions, and timestamps.

**Exploit sketch:**  
On multi-user systems, another local user with access to the data dir can learn which profiles are being synced and when.

**Fix:**  
Write with restrictive permissions on creation (`0o600` where supported), and document the data-dir trust boundary.

---

## Medium — Google OAuth pending state and account metadata are stored plaintext in the data dir
**File:** `apps/api/src/application/google/google-auth.service.ts:65-82`, `apps/api/src/application/google/google-auth.service.ts:271-276`, `apps/api/src/application/google/google-auth.service.ts:261-269`

**Issue:**  
`google/oauth-pending.json` persists PKCE verifier, account name, scopes, and expiry in plaintext; `google/accounts.json` persists connected account names in plaintext.

**Exploit sketch:**  
A local attacker with read access to the QueuePilot data dir can steal an in-flight OAuth verifier and complete a pending loopback auth flow, or enumerate connected Google accounts.

**Fix:**  
Store pending auth state in the `SecretStore`, or at least persist only opaque state IDs with verifier material in the secret store. Tighten file permissions if plaintext metadata is retained.

---

## Low — Proxy credentials can remain plaintext in SQLite in test/legacy/non-secret-store paths
**File:** `apps/api/src/application/proxies/proxy.service.ts:20-31`, `apps/api/src/application/proxies/proxy.service.ts:34-49`, `apps/api/src/application/secrets/secret-store.ts:140-183`

**Issue:**  
If `SecretStore` is absent, proxy passwords are still stored directly in SQLite rows (`stored.password = input.password ?? null`). In production `main.ts` always wires a secret store, so this is not a production-path vulnerability on supported platforms, but it is still a real secret-handling downgrade path.

**Exploit sketch:**  
A developer or operator explicitly running with plaintext secret storage (`QUEUEPILOT_SECRET_STORE=plaintext`) or custom wiring without `SecretStore` leaves proxy credentials recoverable from disk.

**Fix:**  
Refuse startup for real runtimes without a non-plaintext secret store, not just on unsupported platforms. Keep plaintext store test-only.

---

## Low — Session bundle decryption uses synchronous PBKDF2 on request thread; large repeated requests can CPU-pin the API
**File:** `apps/api/src/application/bundles/session-bundle.ts:22-24`, `apps/api/src/application/bundles/session-bundle.ts:67-69`, `apps/api/src/application/bundles/session-bundle.ts:106-132`

**Issue:**  
`pbkdf2Sync(..., 310_000, ...)` runs on the main event loop for export/import/restore operations.

**Exploit sketch:**  
An authenticated caller can send repeated bad bundle imports and stall the API thread during KDF work. This is a local authenticated DoS, not a confidentiality/integrity break.

**Fix:**  
Move bundle crypto to async `pbkdf2` or worker threads.

---

## Low — Dynamic module loading from writable data-dir folders is an intentional but powerful supply-chain trust boundary
**File:** `apps/api/src/application/jyl/jyl-registry.ts:94-173`, `apps/api/src/application/parsers/parser-registry.ts:54-77`, `apps/api/src/application/plugins/plugin-registry.ts:62-112`

**Issue:**  
The API imports executable `.mjs` and plugin packages directly from `<dataDir>/{jyl,parsers,plugins}` with no signing, no allowlist, and no isolation.

**Exploit sketch:**  
Any local malware or another user able to write into the operator’s data dir gets code execution in the API process on next rescan/start.

**Fix:**  
Given scope, this is probably acceptable, but document the data-dir as code-trusted. If hardening is wanted: permission checks on startup, disabled auto-rescan, optional plugin hash allowlist.

---

# 2. OUTDATED / POOR PRACTICES

## `withTimeout()` can call `clearTimeout` on an uninitialized handle
**File:** `apps/api/src/application/jyl/jyl-registry.ts:321-332`

**Issue:**  
`let t: NodeJS.Timeout;` is definitely assigned only inside the raced promise constructor, then `finally { clearTimeout(t!); }`. It works in practice, but is brittle and relies on execution ordering.

**Why it bites:**  
Typing lies (`!`) around timer lifecycle are easy to regress and hard to reason about under refactors.

**Fix:**  
Initialize `let t: NodeJS.Timeout | undefined;` and guard `if (t) clearTimeout(t)`.

---

## Event-stream clients are never pruned on failed writes
**File:** `apps/api/src/http/events.routes.ts:10-33`

**Issue:**  
SSE broadcast loops over `clients` and writes blindly; failed writes do not remove dead clients except via `req.raw.on("close")`.

**Why it bites at 100 profiles / active dashboards:**  
Dead TCP peers can accumulate until kernel/socket closure propagates; repeated writes may throw or backpressure unpredictably.

**Fix:**  
Check `reply.raw.destroyed`/`writableEnded`, catch write failures, and prune on error.

---

## CDP WebSocket error handling likely underreports real socket errors
**File:** `apps/api/src/application/runtime/cdp/cdp-connection.ts:34-49`

**Issue:**  
`error` event message extraction uses `(ev as { message?: string }).message`, but browser/undici WebSocket error events typically do not carry useful message text.

**Why it bites:**  
Operational diagnosis becomes “unknown” for connection failures.

**Fix:**  
Capture close code/reason if available; include target URL and surrounding context, not just event `.message`.

---

## `profile.operation.mutex` is in-memory only; cross-process correctness depends entirely on DB exceptions
**File:** `apps/api/src/application/lifecycle/profile-operation.mutex.ts:8-29`, `apps/api/src/application/lifecycle/browser-run.repository.ts:19-34`

**Issue:**  
This is mostly fine because the DB unique index is the real guard, but the codebase still treats the mutex as a first-line synchronizer. Under multiple API processes, many paths outside `create/admit` remain process-local.

**Why it bites:**  
At higher concurrency or multiple API instances, behavior becomes more exception-driven and less deterministic.

**Fix:**  
Document single-writer expectation more explicitly, or move more sequencing into DB transactions.

---

## `parseCsv()` explicitly does not support embedded newlines
**File:** `apps/api/src/application/profiles/profile-import.ts:66-111`

**Issue:**  
The comment says “No embedded newlines.”

**Why it bites:**  
Real CSVs from spreadsheets routinely contain quoted multiline notes. Import behavior will break or mis-parse.

**Fix:**  
Use a maintained CSV parser or implement RFC 4180 properly.

---

## Warmup recording polls tabs instead of subscribing to browser/navigation events
**File:** `apps/api/src/application/warmups/warmup.service.ts:87-129`

**Issue:**  
Recording fidelity is bounded by polling interval and tab-registry state only.

**Why it bites:**  
At scale or shorter dwell patterns, recorded sequences become inaccurate; frequent polling adds load.

**Fix:**  
If Fury/CDP is the primary runtime, add optional navigation-event capture via CDP for running sessions.

---

## `ProxyService.test()` computes latency twice
**File:** `apps/api/src/application/proxies/proxy.service.ts:95-119`

**Issue:**  
`Date.now() - started` is computed once for repository record and again for return payload.

**Why it bites:**  
Minor inconsistency between persisted and returned latency.

**Fix:**  
Compute once and reuse.

---

## Sync file writes generally lack durability semantics
**Files:**  
- `apps/api/src/application/lifecycle/launch-identity.service.ts:49-53`  
- `apps/api/src/application/team/team-sync-loop.ts:59-64`  
- `apps/api/src/application/settings/settings-bundle.service.ts` (multiple writes via downstream services)  
- `apps/api/src/application/google/google-auth.service.ts:271-276`

**Issue:**  
Atomic rename is used, but no fsync on file or parent directory.

**Why it bites:**  
Power loss can still drop “successful” writes.

**Fix:**  
If durability matters, fsync temp file then parent dir before/after rename.

---

## Dynamic plugin store uses read-modify-write without locking
**File:** `apps/api/src/application/plugins/plugin-registry.ts:113-132`

**Issue:**  
`store.set()` loads JSON, mutates, writes back with no synchronization.

**Why it bites:**  
Concurrent plugin calls can lose updates.

**Fix:**  
Keep in-memory store with flush serialization, or file lock / append-log semantics.

---

## `WindowTilingService.driverFor()` leaks CDP connections
**File:** `apps/api/src/application/windows/window-tiling.service.ts:47-59`

**Issue:**  
It creates a `CdpConnection` and wraps it in `cdpWindowDriver(conn)`, but the connection is never closed.

**Why it bites:**  
Repeated tile/restore operations leak sockets/file descriptors.

**Fix:**  
Return a `{ driver, close }` pair or make tiling methods own the `CdpConnection` lifecycle with `finally { conn.close(); }`.

---

# 3. BEST-PRACTICE GAPS

## No structured logging / observability
**Evidence:** `apps/api/src/app.ts:57` creates Fastify with `logger: false`; ad hoc `console.log/warn` appears in `main.ts:88-93`, `main.ts:180-184`, `main.ts:219-220`, `fury-core.runtime.ts:502`, `fury-core.runtime.ts:509`, `secret-store.ts:190-193`.

**Gap:**  
For a browser-orchestration system handling 10–100 profiles, 2026 baseline is structured logs with correlation IDs, launch/run IDs, and error categories.

**Recommendation:**  
Enable Fastify logger (pino), add request IDs, and emit structured lifecycle/proxy/engine events.

---

## No metrics surface
**Evidence:** no metrics module/routes anywhere in repo tree.

**Gap:**  
No counters/gauges for active profiles, launch failures by stage, proxy test success rate, team sync lag, CDP connect latency, or bundle import/export timings.

**Recommendation:**  
Add Prometheus/OpenTelemetry metrics, at least for lifecycle and proxy health.

---

## Dependency hygiene is minimal
**Evidence:** package manifests use broad `^` ranges; no lockfile provided in pack; no audit policy; dynamic imports of local code.

**Gap:**  
For this risk class, you want pinned production deploys, SBOM/artifact attestations for the Chromium fork, and dependency scanning.

**Recommendation:**  
Pin deploy artifacts via lockfile, add CI dependency audit, and produce checksums/SBOM for `fury-core` builds.

---

## Very limited HTTP hardening
**Evidence:**  
- No rate limiting routes.
- No content-security/other headers configured.
- No CSRF/browser-origin protection middleware.
- Bearer token auth only, with loopback trust when unset (`apps/api/src/config/config.ts:22-25`, `apps/api/src/app.ts:57-73`).

**Gap:**  
Even for local-first apps, 2026 norm is explicit browser-origin hardening and route-level abuse controls.

**Recommendation:**  
Add:
- loopback-only + explicit `Origin` allowlist/deny policy,
- rate limits on expensive routes (`bundle`, `team sync`, `engine self-test`, `proxy test`),
- security headers for dashboard responses.

---

## Testing is broad but not stress-oriented
**Evidence:** extensive unit/API tests exist under `apps/api/tests`, but no soak/load/concurrency tests are present in tree.

**Gap:**  
The repo is strong on correctness tests, weak on “100 concurrent profiles / repeated start-stop / SSE fanout / file-descriptor leak / CPU saturation” tests.

**Recommendation:**  
Add stress suites for:
- repeated CDP attach/detach,
- batch start/stop under cap,
- window tiling leak regression,
- team sync retry storms,
- proxy relay connection churn.

---

## Config is environment-only and partially split between env and DB settings
**Evidence:** `apps/api/src/config/config.ts`, plus runtime behavior from DB-backed `SettingsService`.

**Gap:**  
Operationally this creates two sources of truth: env for startup-critical config, DB for automation/team behavior.

**Recommendation:**  
Document precedence explicitly and add a single `/config/effective` diagnostics endpoint that redacts secrets.

---

# 4. ARCHITECTURE WEAKNESSES

## API process is a monolith containing control plane, secret handling, plugin runtime, browser lifecycle, proxy relay, team sync loop, and web console
**Evidence:**  
`apps/api/src/main.ts:95-220` wires all concerns into one process.

**Weakness:**  
A crash, deadlock, or CPU pin in any one subsystem (PBKDF2 bundle work, plugin code, proxy relay churn, warmup playback, team sync loop) impacts all others.

**Impact on roadmap:**  
This will make “Jancy parity” features like more scripting, plugins, and richer sync progressively riskier.

**Suggestion:**  
Split long-running/background functions first:
- team sync loop into separate worker,
- plugin/JYL execution into isolated subprocess or worker,
- relay into explicit managed component if proxy traffic grows.

---

## Runtime adapters own too much behavior beyond “launch a browser”
**Evidence:**  
`fury-core.runtime.ts` handles bookmark deployment, profile hygiene, proxy relay, egress measurement, os-crypt key management, start-page logic, window-fit setup.

**Weakness:**  
The runtime boundary is overloaded. Launch-time policy and side effects are coupled to one engine implementation.

**Impact:**  
Makes adding another Chromium-family engine or headless lane harder; also makes runtime tests large and stateful.

**Suggestion:**  
Move launch orchestration into composable pre-launch/post-launch services; keep adapters closer to process spawn + CDP capability wiring.

---

## State is split across SQLite, profile dirs, JSON sidecar files, and in-memory registries
**Evidence:**  
- SQLite: profiles/runs/proxies/settings (`database.ts`)
- JSON files: snapshots, warmups, google pending/accounts, bookmark known IDs, plugin stores, extension registry
- in-memory only: tabs/partitions, JYL stores/logs, SSE clients, plugin logs

**Weakness:**  
Recovery semantics differ by subsystem; restart behavior is inconsistent.

**Impact:**  
Blocks robust multi-process or multi-machine semantics and complicates support/debugging.

**Suggestion:**  
Classify state into:
1. durable authoritative,
2. durable cache,
3. ephemeral runtime.  
Then normalize storage per class.

---

## Team sync/lease integration is bolted on rather than first-class lifecycle state
**Evidence:**  
`BrowserLifecycleService` accepts optional `leaseGuard`; `TeamSyncLoop` runs after app listen in `main.ts:216-220`.

**Weakness:**  
Cross-machine semantics are add-ons around a single-machine lifecycle model.

**Impact:**  
Future true collaboration features will run into consistency edges: adopted runs after restart, sync watermarks, bundle import phases, lease expiry race windows.

**Suggestion:**  
If parity expands, model “profile location / lease / sync revision / import pending” as explicit domain state, not side effects around runs.

---

## In-memory tab registry prevents restart-safe tab/session workflows
**Evidence:** `apps/api/src/application/tabs/tab-registry.ts:14-112`

**Weakness:**  
After API restart, adopted runs cannot manage tabs because partition mapping is gone.

**Impact:**  
This blocks richer tab ops, warmup continuity, scripted flows, and any serious long-lived session management.

**Suggestion:**  
Persist tab/partition metadata keyed by run ID, with explicit “stale after restart” versioning if full recovery isn’t possible.

---

# 5. JANCY-PARITY GAPS

I can compare only against `docs/parity.md` included here and the product description you gave; I do **not** have Jancy source/docs beyond what the repo itself states.

## Priority 1 missing/partial features

### 1. Egress diagnostics API/UI is still partial
**Repo evidence:** `docs/parity.md` marks “Egress diagnostics” as partial/❌ in §2, but code now has `egressDiagnostics()` and `/profiles/:id/egress` (`browser.lifecycle.service.ts:478-506`, `runs.routes.ts:193-202`).

**Gap:**  
Docs are stale and likely UI parity is still missing. If not exposed in console, operators won’t benefit.

**Worth building?** Yes. High value, low scope.

---

### 2. Per-profile extensions registry was listed missing but is now implemented; docs/parity are stale
**Repo evidence:** `application/extensions/*`, `http/extensions.routes.ts`

**Gap:**  
Parity doc is outdated, not code. Update docs and add UX.

**Worth building more?**  
Basic install/copy/remove: yes.  
A full extension marketplace or signing system: **not worth it** for family/friends scope.

---

### 3. TOTP per profile was listed missing but is now implemented; docs/parity are stale
**Repo evidence:** `application/profiles/totp.service.ts`, routes in `profiles.routes.ts:191-214`

**Gap:**  
Again a docs/UI parity lag, not backend absence.

**Worth building more?**  
Current seed/code endpoints: yes.  
QR enrollment wizards / authenticator sync cloud: **not worth it**.

---

### 4. Warmup recorder/player remains backend-only / likely thin UX
**Repo evidence:** `application/warmups/warmup.service.ts`, `http/warmups.routes.ts`; `docs/parity.md` still says ❌.

**Gap:**  
Needs console integration and probably better runtime fidelity.

**Worth building?** Yes, if users really do account warming. This is one of the few workflow features aligned with the product.

---

### 5. CSV/Sheets workflow still lacks XLSX import
**Repo evidence:** `docs/parity.md` §2 and §4 call out xlsx import as missing; no xlsx parser in tree.

**Worth building?**  
Maybe. CSV/Sheets already cover most family/friends use. XLSX support is convenient but not essential.

---

### 6. Resolver ecosystem is still partial vs Jancy-style provider breadth
**Repo evidence:** built-ins are `static/env/webhook`, plus `imap/gmail`, plugins can add more (`resolver-registry.ts`, `gmail-resolver.ts`, `imap-resolver.ts`, `plugins.routes.ts`).

**Gap:**  
Missing turnkey resolvers for common account-management flows (SMS providers, captcha providers, mailbox vendors).

**Worth building?**  
A plugin SDK/examples: yes.  
A long tail of built-in commercial provider integrations: **not worth building** for family/friends scope; let plugins cover it.

---

### 7. Rich tab operations are still minimal
**Repo evidence:** open/close/list/query/bulk-open/bulk-close exist (`tabs.routes.ts`), but no refresh, navigate existing tab, activate/focus, duplicate, move, or DOM-aware ops.

**Worth building?**  
A few high-value ops like navigate/reload/activate: yes.  
Full browser-style tab management surface: probably **not worth it** unless scripting consumers need it.

---

### 8. Portable profile/session roaming is partial
**Repo evidence:** bundles carry cookies, tabs, metadata, proxy reference, but not full storage/extensions; `docs/parity.md` still calls “Portable profile bundles” missing.

**Worth building?**  
Selective storage persistence could be high value.  
Full cross-machine opaque profile migration, including all extension/app storage, is high complexity and fragile; likely **not worth it** for this scope.

---

## Priority 2 roadmap blockers

### 9. Mobile persona suite absent at app level
**Repo evidence:** `docs/parity.md` §1 says engine has mobile persona support but identity model is desktop-only.

**Worth building?**  
Probably **not worth it** for family/friends scope unless actual users need mobile account handling. It multiplies complexity across windowing, media, input, WebRTC, and profile UX.

---

### 10. Console UX depth still partial
**Repo evidence:** `docs/parity.md` says “bulk ops, search, health badges” partial and React intentionally deferred.

**Worth building?**  
Some UX polish around current vanilla JS is worth it.  
A major frontend rewrite is **not worth it** unless current console materially blocks use.

---

### 11. Team sync is manual/pull-dominant and not full collaboration
**Repo evidence:** `team-sync-loop.ts` only pulls; `team-sync.ts` push is operator-invoked.

**Worth building?**  
For family/friends, current “good enough sync” may be sufficient.  
Full collaborative sync/conflict UX/RBAC/audit trails are **not worth building** for this tool.

---

## Scope-discipline: features **not worth building** for a family/friends tool

1. **RBAC / enterprise multi-user permissions** — already deferred and should stay deferred.
2. **Extension marketplace / signing infrastructure** — huge trust and support burden.
3. **Large catalog of built-in commercial integrations** — better as plugins.
4. **Full SaaS-grade team collaboration features** — overkill.
5. **Mobile persona completeness unless demanded by real users** — very high complexity.
6. **Heavy frontend rewrite for its own sake** — unless current console becomes unusable.
7. **Cloud account system / remote management portal** — conflicts with local-first trust model.

---

# 6. VERDICT

Overall, this is a surprisingly disciplined codebase for a niche high-risk product: the lifecycle core, runtime verification mindset, path-containment fixes, proxy secret handling, and relay-based proxy enforcement are materially better than typical antidetect tooling. The top 3 risks are: **(1)** scripting/JYL/plugin endpoints become a real local RCE/exfiltration surface if enabled without a bearer token or browser-origin hardening, **(2)** `WindowTilingService` leaks CDP connections and will hurt stability under repeated use, and **(3)** secret-adjacent metadata and OAuth pending state are still written plaintext in the data dir. The top 3 quick wins are: **(a)** require `SPECTRA_API_TOKEN` whenever scripting endpoints are enabled and add cross-site request/origin denial, **(b)** fix the tiling CDP connection leak, and **(c)** add structured logging/metrics so 50–100-profile operation can be debugged without guesswork.