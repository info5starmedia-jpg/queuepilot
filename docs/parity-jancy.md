# Jancy Feature Parity — QueuePilot audit

Audit date: 2026-11-14. Sources: `Jancy-Clone-Deep-Dive-and-Build-Plan.md`
(every docs.jancy.io section read: profiles, resolvers, proxies, cookies, tabs,
autofill, JYL, settings, all 31 plugin pages, developers) + public Jancy docs.

Mission formula check: Fury engine ✅ (0.5.5-parity, 43/43 harness) ·
AliasMode lifecycle ✅ (discipline adopted 2026-11-14) · **Jancy workflow —
this document is the verdict.**

Legend: ✅ have · 🟡 partial · ❌ missing · ➖ deliberately different/out of scope

## 1. Profiles

| Jancy feature | Status | Notes |
| --- | --- | --- |
| Profile providers (CSV + Google Sheets, refreshable, many) | 🟡 | Sheets provider ✅ (P1.5). CSV import ✅ but see columns below |
| Required columns `Profile/Name/Email` | ✅ | v0.14.7: `email` column in CSV import (validated; empty cell on re-import leaves it unchanged), `PATCH /profiles/:id` accepts `email` incl. explicit null-clear; profile create takes `email` |
| Optional: group, notes, timezone, URL, favorite | 🟡 | group/notes/timezone ✅ in import; URL ✅ v0.14.12 (CSV `url` column, `\|`-separated start pages opened at launch); favorite ✅ v0.14.10 |
| Optional: address/DOB/phone/SMS/passcodes/Free 1–10 | ✅ | v0.14: typed layer over `profile.extra` (schemas in contracts, safe-parse read). `PATCH /profiles/:id/persona`, SMS cycling `POST /profiles/:id/sms/rotate`, well-known 2FA fields (`extra.fields`) bound into resolve. Panel UX still ❌ (React-deferred) |
| Optional: credit-card sets | ✅ | v0.14: shared `PersonaCreditCardSchema` (import contract reuses it), typed merge via persona patch; `GET /profiles/:id/cards` is masked-only (last4 + hasCvv + metadata — PAN/CVV never echoed); `POST /profiles/:id/autofill/card` fills the live page over CDP (§7) |
| Per-profile proxy list + "system connection" magic value | ✅ | v0.14: `extra.proxies` typed parse (host:port[:user[:pass]], scheme prefix, system connection), `GET /profiles/:id/proxies` masked, `POST …/proxies/rotate` cycles persisted index; launches with no attached proxy use the current entry (proxySource `profile-list`, drift-explained). Multi-proxy PER-LAUNCH rotation ✅ v0.16 (`6a1ede3`, D-003): rotation links resolve a provider-pool endpoint per launch (`proxySource: "rotation"`, snapshot.proxyId = resolved id, loud refusal when no resolver is wired) |
| Tab color per profile | ✅ | v0.14.10: `tabColor` (#rgb/#rrggbb, validated) rides the persona bag — CSV `color` column, PATCH persona, console color dot per profile. Engine-side tab tinting deliberately out of the TS layer |
| Profile panel UX (search, per-field copy, code refresh, assignment modes, keybinds) | 🟡 | v0.14.20: full profile panel on the vanilla console — search, persona/2FA fields, cards (masked), proxies, SMS cycling, favorite/color, start URLs, notes. React rewrite stays deferred (ADR-0005); Jancy's keybinds/assignment-mode extras ❌ |

## 2. Resolvers & parsers (the 2FA layer)

| Feature | Status |
| --- | --- |
| `Site:` columns with resolver syntax | 🟡 | `profile.extra.sites`, wildcard `*`, most-specific wins; `resolveSiteField` + `POST /profiles/:id/resolve` |
| Resolver registry (gmail, imap, smsgateway, textchest, …) | 🟡 | ✅ static/env/webhook/imap/gmail (OAuth, multi-account, DPAPI tokens). Provider-specific APIs (textchest…) = plugin content |
| Email/SMS parser registry (`jancy://parsers`) | 🟡 | `ParserRegistry` loads user `.mjs` from `<dataDir>/parsers` ✅; auto-fetch mailboxes ❌ |
| Token aliases (@alias → real key in settings) | ✅ | `@name` → SecretStore (DPAPI), `PUT/DELETE /aliases/:alias` |
| User-defined parsers without a release (JYL) | ✅ | `.mjs` parser modules; commands/macros/web-endpoints all in `<dataDir>/jyl` |

**Was the largest single gap.** v0.14 closed the core: resolver registry ✅,
Site columns ✅, typed persona/2FA fields ✅ with resolve binding, SMS cycling
✅, parsers + aliases + JYL ✅. What remains is plugin/provider content
(specific 2FA APIs) and panel UX (React-deferred). Plugin-shaped by design (see
§6).

## 3. Proxies

| Feature | Status | Notes |
| --- | --- | --- |
| Proxy providers (delimited, header, timezone column) | ✅ | P1.5 incl. Sheets |
| Distribution: persist / start-over / random | ✅ | `POST /proxy-providers/:id/next` |
| Provider actions (star default, refresh, trash, test) | 🟡 | refresh/test/delete ✅; star/default ✅ v0.14.10 (`POST /proxy-providers/:id/star`, one starred default per workspace, console section). Soft-delete trash for providers ❌ (profiles got trash v0.15.1; providers are hard-delete only) |
| Per-proxy timezone applied at assignment | 🟡 | Timezone lives on identity, not per-proxy switch |
| Temporary proxies per launch | ✅ | P1.5, never persisted |
| socks5 upstream in relay | ✅ | P7.2 done; live `egress-via-socks5` PASS |
| CLI `--proxy-provider` | ✅ | v0.14.10: `profile start NAME --proxy-provider POOL` — next-proxy attach then start; password never leaves the server |

## 4. Tabs

| Feature | Status | Notes |
| --- | --- | --- |
| Isolated in-memory partitions + related tabs | ✅ | P1.5, more rigorous (launch-identity snapshot per run) |
| Engine-side tab routing | ✅ | CDP contexts |
| Tab bar / vertical Tab View, 7 sort modes | 🟡 | Console Tabs panel (v0.14.8): per-running-profile tab table w/ query, select-all, close; v0.14.12: sort modes ✅ (newest/oldest/url/domain/status/partition — the six orderings real tab records can honor; no page-title tracking in the API, vertical bar ❌) |
| Mass select + "(all selected)" commands | ✅ | v0.14.8: `POST /profiles/:id/tabs/bulk-close` by `tabIds` OR Thinger `q` — per-tab results, idempotent closes; console select-all + Close selected |
| Tab context menu commands (set profile, color, timezone, clear cookies, screenshot, duplicate, move window) | 🟡 | cookie clear (partition-scoped) ✅ v0.14.9, bulk-close/bulk-open ✅ v0.14.8; per-tab reload / duplicate (same partition) / screenshot ✅ Phase 2 (`16cf765`); per-tab move/set-color/set-profile/timezone ❌ (window tiling presets ✅ v0.14.15 cover the move-window shape at launch) |
| Tab Thinger (formula query language over tabs) | ✅ | v0.14.8 minimal slice: `[!]field:pattern` tokens ANDed (`status`/`url`/`id`/`partition`/`related`/`engine`), `*` wildcard, bare token = url sugar, partition = prefix match; unknown fields refuse 400; `POST /profiles/:id/tabs/query` |
| Tab Studio (visual bulk editor) | ❌ | Later phase |
| Tab priority from page signals (queue position → band) | ❌ | Plugin-shaped (§6) |
| Auto-reload per tab | ✅ | Phase 2 (`16cf765`): `POST /profiles/:id/tabs/:tabId/auto-reload {intervalSec}` (5 s – 1 h, 0 = off), console picker per tab; dies with the tab/run |
| Named windows, max tabs/window, closed-tab restore | ❌ | |
| Bulk-open unique URLs w/ matching proxies, staggered navigation | 🟡 | v0.14.8: `POST /profiles/:id/tabs/bulk-open` opens many URLs (optional shared `relatedTo` partition), per-url results; v0.14.12: `staggerMs` ✅ (0–10 s between opens); proxy matching ❌ |
| Tab strings (shareable tab definitions) | 🟡 | Session bundles v2 carry tabUrls — closest equivalent |
| Load cookies into partitions | ✅ | v0.14.12: `POST /profiles/:id/cookies/load` bulk-loads cookies (max 500, per-cookie results) optionally scoped to one partition through its open tabs' contexts; single-cookie partition set/list/clear since v0.14.9 |

## 5. Cookies

| Feature | Status | Notes |
| --- | --- | --- |
| Per-tab / mass cookie clearing | ✅ | v0.14.9: `POST /profiles/:id/cookies/clear` — domain/name wildcard filter, whole-run or partition-scoped (deletes through a live page in the partition); refuses a filter-less whole-jar wipe |
| Cookie Thinger (programmable cookie surgery) | ✅ | v0.14.9: `GET /profiles/:id/cookies` (wildcard filters, partition scoping via `Network.getCookies{browserContextId}`), `POST …/cookies` set (partition-aware), `POST …/cookies/clear` mass delete with per-cookie results |

## 6. Scripting & plugins

| Feature | Status | Notes |
| --- | --- | --- |
| Client SDK + script runner | ✅ | P3 (`@queuepilot/client`, `queuepilot script`) — our scripting entry |
| JYL (user commands/macros/parsers/web endpoints) | ✅ | All four as `.mjs` in `<dataDir>/jyl` (74d46e6 + P7.10 web endpoints) |
| Plugin system (~25 registries) | 🟡 | `PluginRegistry` core ✅ + JYL command/macro registry ✅. Remaining registries adopt as needed |
| Userscripts (Greasemonkey subset) | ❌ | |
| Web interface with extensible endpoints | ✅ | REST API + console + JYL module endpoints (`/jyl/endpoint/<module>/<path>`) |
| Site plugins (ticketmaster/queue-it/namath/…) | ➖ | Commercial ticket-bot ecosystem; parser/registry concepts adopted via §2/§6 |

## 7. Power-user surface

| Feature | Status |
| --- | --- |
| Command palette | ❌ |
| Editable keybinds | ❌ |
| Menu editor | ❌ |
| Format strings (tab title/window title templates) | ❌ |
| Theme editor | ❌ |
| Settings bundles (.jnc export/import) | ✅ | `GET /settings/export` + `POST /settings/import` — secrets-free JSON (P7.10) |
| Preference sets | ❌ |
| Network logger (net-export) | ❌ |
| Autofill + simulated typing (WPM) | 🟡 | Card autofill ✅ v0.14.4: `POST /profiles/:id/autofill/card` — hint-based field detection, native-setter + input/change events (React-safe), expiry format adaptation, values never leave the machine. Address/identity autofill ✅ v0.14.5: `POST /profiles/:id/autofill/address` — name split from profile, persona phone/DOB/address, state matched in `<select>` options (value or text, abbrev or full), 409 when no identity data. WPM typing ✅ v0.14.6: `POST /profiles/:id/autofill/type` — keystroke-paced into the focused element (input/textarea/contenteditable), per-key delay from wpm (20–400, default 60) with ±35% jitter, punctuation pauses and micro-pauses, scaled evaluate timeout; reports typed/ms only, `no-focused-field` when nothing focused. §7 row COMPLETE |
| Purchase coordination (Namath) | ➖ |

## Where QueuePilot exceeds Jancy (keep)

- C++-level fingerprint engine (Fury BSD patches) — Jancy is JS-level noise
- Fingerprint attestation verdict per profile — Jancy doesn't have it
- Launch-identity snapshots, drift, edit-while-running discipline
- Session bundles v2 (encrypted roaming, no password travel)
- Engine installer/update: checksummed, consent-gated, stall-resuming
- Claim suite (25) + Fury harness (43) as CI-style gates

## Priority-ordered gaps → P7 items (suggested)

1. **Resolver + parser registries + token aliases** (§2) — the killer feature;
   plugin-shaped, start with gmail/imap/sms-gateway resolvers.
2. **Plugin registry architecture** (§6) — must exist before 1 so resolvers
   ARE plugins (Jancy's own lesson: registries first).
3. **Profile model expansion** (§1): email, address/DOB/phone/SMS/passcodes,
   URL start pages, favorite; CSV columns to match.
4. **Tab console depth** (§4): tab view, mass select, Tab Thinger.
5. **Cookie Thinger** (§5) + per-partition cookie ops.
6. ~~**Autofill typing simulation** (§7)~~ — ✅ DONE (v0.14.6): the §7
   autofill row is fully green.
7. Power-user surface (palette, keybinds, format strings) — last.

Rule unchanged: every adopted feature ships with its claim/verify proof.

---

## Final sign-off (2026-11-16, v0.15.1)

Row-by-row re-verification against the code as of v0.15.1 (565 API tests +
18 server tests green). Rows updated above where v0.14.12 → v0.15.1 closed
or moved them.

**Verdict: workflow parity PASSED** for the daily-driver surface. Every
remaining ❌/🟡 row is one of three kinds:

1. **None in build** — the last in-build row (per-launch multi-proxy
   rotation, D-003) shipped 2026-11-16 (`6a1ede3`).
2. **Deliberately deferred** (owner-approved scope calls, not oversights):
   power-user polish (command palette, keybinds, menu editor, format
   strings, theme editor, preference sets, network logger — original plan
   ranks these last), Tab Studio / tab priority / auto-reload / closed-tab
   restore (later phase), provider soft-delete trash, per-tab
   screenshot/duplicate.
3. **Plugin-shaped content** — specific 2FA provider APIs (textchest…),
   auto-fetch mailboxes, userscripts, site plugins (commercial ticket-bot
   ecosystem, deliberately out of scope). The registries they plug into all
   exist and ship in-tree.

Deliberately-different (➖) stands: C++ engine vs JS noise, attestation,
launch snapshots, encrypted bundles, checksummed installer — documented in
"Where QueuePilot exceeds Jancy" above and kept.

