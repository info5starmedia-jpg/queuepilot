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
| Required columns `Profile/Name/Email` | ❌ | Import supports `name` only; no email column |
| Optional: group, notes, timezone, URL, favorite | 🟡 | group/notes/timezone ✅ in import; URL start pages ❌; favorite ❌ |
| Optional: address/DOB/phone/SMS/passcodes/Free 1–10 | ✅ | v0.14: typed layer over `profile.extra` (schemas in contracts, safe-parse read). `PATCH /profiles/:id/persona`, SMS cycling `POST /profiles/:id/sms/rotate`, well-known 2FA fields (`extra.fields`) bound into resolve. Panel UX still ❌ (React-deferred) |
| Optional: credit-card sets | ✅ | v0.14: shared `PersonaCreditCardSchema` (import contract reuses it), typed merge via persona patch; `GET /profiles/:id/cards` is masked-only (last4 + hasCvv + metadata — PAN/CVV never echoed). Autofill wiring pending |
| Per-profile proxy list + "system connection" magic value | 🟡 | One proxyId per profile; multi-proxy cycling ❌ |
| Tab color per profile | ❌ | |
| Profile panel UX (search, per-field copy, code refresh, assignment modes, keybinds) | ❌ | Console is grid + actions only |

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
| Provider actions (star default, refresh, trash, test) | 🟡 | refresh/test/delete ✅; star/default ❌ |
| Per-proxy timezone applied at assignment | 🟡 | Timezone lives on identity, not per-proxy switch |
| Temporary proxies per launch | ✅ | P1.5, never persisted |
| socks5 upstream in relay | ✅ | P7.2 done; live `egress-via-socks5` PASS |
| CLI `--proxy-provider` | ❌ | CLI exists; no provider flag |

## 4. Tabs

| Feature | Status | Notes |
| --- | --- | --- |
| Isolated in-memory partitions + related tabs | ✅ | P1.5, more rigorous (launch-identity snapshot per run) |
| Engine-side tab routing | ✅ | CDP contexts |
| Tab bar / vertical Tab View, 7 sort modes | ❌ | No console tab view |
| Mass select + "(all selected)" commands | ❌ | |
| Tab context menu commands (set profile, color, timezone, clear cookies, screenshot, duplicate, move window) | ❌ | API has stop/openTab; no bulk ops |
| Tab Thinger (formula query language over tabs) | ❌ | Adopt — small parser, huge payoff |
| Tab Studio (visual bulk editor) | ❌ | Later phase |
| Tab priority from page signals (queue position → band) | ❌ | Plugin-shaped (§6) |
| Auto-reload per tab | ❌ | |
| Named windows, max tabs/window, closed-tab restore | ❌ | |
| Bulk-open unique URLs w/ matching proxies, staggered navigation | ❌ | |
| Tab strings (shareable tab definitions) | 🟡 | Session bundles v2 carry tabUrls — closest equivalent |
| Load cookies into partitions | 🟡 | Bundle restore imports cookies at profile level; per-partition ❌ |

## 5. Cookies

| Feature | Status | Notes |
| --- | --- | --- |
| Per-tab / mass cookie clearing | ❌ | Engine-side only |
| Cookie Thinger (programmable cookie surgery) | ❌ | Adopt — unique power feature |

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
| Autofill + simulated typing (WPM) | ❌ |
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
6. **Autofill with typing simulation** (§7).
7. Power-user surface (palette, keybinds, format strings) — last.

Rule unchanged: every adopted feature ships with its claim/verify proof.
