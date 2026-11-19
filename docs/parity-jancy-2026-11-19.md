# Jancy Wiki Parity Audit: 2026-11-19

**Source:** the Jancy product wiki (Notion, `nitrane.notion.site/bef7a288…`).
All 115 top-level pages and their sub-pages were read in full: Tabs,
Cookies, Profiles, Proxies, Autofill (with 56 site maps), Email Integrations,
"Can I?", Format Strings, Custom Sort, Custom Key Binds, Advanced, Custom
Email Parsers (31), Custom SMS Parsers (11) and Common Errors (14).

**Compared against:** `main` @ `e90958a` (v0.16.x, 667 API tests green).

**Companion to:** [parity-jancy.md](parity-jancy.md), the 2026-11-16 sign-off.
That document still holds for what it covered.

Legend: ✅ have · 🟡 partial · ❌ missing · 🐞 present but broken ·
➖ deliberately different / out of scope · 🖥 needs a UI layer (see §4)

---

## 0. The verdict changes

The 2026-11-16 sign-off said **"workflow parity PASSED"**. That audit used
`docs.jancy.io` section pages and a build-plan file. The product wiki is a
different source: it shows how Jancy users *actually* run their work, through
recipes, parsers, format strings, key binds and custom commands. Checked
against the wiki, the earlier PASS does not hold, for three reasons.

1. **The 2FA code chain is broken end to end (🐞, not ❌).** QueuePilot has
   resolvers and it has parsers, but nothing connects them (§1, D-1). A
   profile's `emailcode` resolves to a **whole email body**, not a code.
2. **Jancy's CSV and resolver grammar is not accepted.** A Jancy profile CSV
   imported into QueuePilot silently loses its `Site:` columns, and Jancy's
   resolver strings (`emailcode=gmail:<id>:<parser>`,
   `emailcode=imap:host:port:user:pass:<parser>`, `password=$literal`,
   `<smsprovider>:<key>:<parser>`) do not parse (§1, D-2 to D-4).
3. **Whole feature areas were never in scope of the earlier audit:**
   - tab passcodes and tab notes
   - tab data from page signals (queue position, event and artist)
   - priority groups
   - user-authored autofill **map files**
   - format strings
   - custom sort functions
   - the cookie-thinger *file* with action groups and tab-to-tab copy
   - log profile note
   - export tab info
   - tab strings
   - focus delay
   - persist-by-email
   - recording queue positions to Google Sheets

   These are not "deferred polish". The parsers, autofill maps and tab data
   are the daily-driver workflow.

**New verdict: parity REOPENED.** The engine, lifecycle and fingerprint
layers still exceed Jancy (see parity-jancy.md, "Where QueuePilot exceeds
Jancy"). The workflow layer needs the work below.

---

## 1. Defects: present but wired wrong

These come first. They are bugs in features we claim to have, not missing
features.

### D-1 🐞 Resolver → parser chain is not connected

- `gmail-resolver.ts` and `imap-resolver.ts` both end by returning the
  **raw text body** of the newest matching message. Their header comments
  say "the CALLER hands the text to a parser".
- No caller does. `ParserRegistry` is used only by the plugin loader
  (`plugin-registry.ts`) and the manual `POST /parsers/:name/run` route.
  `POST /profiles/:id/resolve` returns the body as `value`.
- **Tests miss it by design.** `gmail.test.ts` and `imap.test.ts` assert
  that a body comes back. `plugins.test.ts` asserts that a parser parses.
  Nothing tests body → code.
- **Further problems on the same path:**
  - The parser's `getQuery()` is never used. Gmail defaults to
    `is:unseen in:inbox` and IMAP to `UNSEEN`, so the mailbox search is not
    narrowed to the sender or site.
  - Only the single newest message is read. If that one isn't the code
    mail, the result is wrong rather than "no code".
  - There is no freshness window, so a stale code can be returned.
  - Codes are never marked as used.
  - IMAP reads INBOX only. Gmail-forwarded and Hotmail-forwarded flows
    need other folders.
- **Fix (Phase J1):** see §4 A-1, the code-retrieval pipeline.

### D-2 🐞 Jancy resolver grammar is not accepted

Results below are for the `Site:` column path (`resolveSiteField` → `reg.resolve`),
which is where Jancy users put these strings.

| Jancy (wiki) | QueuePilot today | Result today |
| --- | --- | --- |
| `password=$Jancyiscool!` | `password=static:Jancyiscool!` | `#NO RESOLVER $Jancyiscool!`. On the persona-field path, `looksLikeSpec` passes it through as the literal **including the `$`**, which is a wrong value |
| `emailcode=gmail:<google-id>:<parser>` | `gmail:<account>?query=…` | the account becomes `<id>:<parser>` → `#NO ACCOUNT <id>:<parser>` |
| `emailcode=imap:<host>:<port>:<user>:<pass>:<parser>` | `imap://host[:port]?user=&pass=&query=` | colon form refused → `#BAD ALIAS` |
| `smscode=seatheros:<API-KEY>:<parser>` (and other SMS providers) | none (only the generic `webhook`) | `#NO RESOLVER` |
| third-party password services (wiki names `automatiq`; 4 exist) | none | `#NO RESOLVER` |

- **Fix:** add a Jancy-grammar adapter in front of `ResolverRegistry.resolve`.
  Our own URL-style forms keep working.
- Table-driven tests should cover every row above.

### D-3 🐞 Jancy profile CSV loses `Site:` columns on import

- `parseProfileRows` (`packages/contracts/src/providers.ts`) knows these
  columns: Profile/Name/Email, SMS Number*, Passcode*, Free 1–10, Proxy*
  and CC sets.
- It has **no `Site: …` handling**. `profile.extra.sites` can only be
  filled through the API. A real Jancy CSV imports "successfully" with its
  2FA config silently dropped.
- The same applies to `Persist Sessions` and `Persist Cookies` (§2.3).
- **Fix:**
  - Parse `Site: Ticketmaster`, `Site: AXS` and `Site: <domain>` headers
    into `extra.sites`.
  - Report unknown headers as import issues instead of dropping them.

### D-4 🐞 Site lookup is exact-key, Jancy's is domain-aware

- `resolveSiteField` does `sites[site] ?? sites["*"]`.
- Jancy's `Ticketmaster` column covers **all** Ticketmaster domains
  (`ticketmaster.com`, `.co.uk`, `.com.mx`, `am.ticketmaster.com`,
  `auth.ticketmaster.com`, …). A custom column is matched by **domain**
  (`www.mlb.com`), and the wiki warns that it is not matched by URL.
- **Fix:** a site-alias table (brand → domain set) plus
  hostname-suffix matching on the tab's current URL. Then resolve can take
  `tabId` or `url` instead of a free-text `site`.

---

## 2. Gap table, by wiki section

### 2.1 Tabs

| Wiki page | Jancy feature | QP | Notes |
| --- | --- | --- | --- |
| Create New Tabs | New tab / new **related** tab to the right | ✅ | `POST /profiles/:id/tabs` with `relatedTo` (partition share) |
| Duplicate Tabs | Duplicate / as related / in new window / as related in new window | 🟡 | Duplicate (same partition) ✅ Phase 2. "Unrelated duplicate" and "in new window" ❌ |
| Create Custom Tabs (Basic) | URL list × N tabs, related toggle, open mode, **tab passcodes**, **tab notes**, proxy provider, new window, focus last | 🟡 | bulk-open with stagger ✅. Count-per-URL, passcodes, notes, provider-per-batch, focus-last ❌ |
| Create Custom Tabs with Profiles | Pick profiles (filter group/state/search) → one tab each | 🟡 | QP equivalent: multi-select profiles → batch launch with start URL ✅. Opening the profile panel per tab 🖥 |
| Focus Delay | Change URL across tabs: focus N s, then navigate, then wait M s | ❌ | Needs `Page.bringToFront` + navigate + per-tab delay. Small |
| Set Different Tab Passcodes | Bulk-assign passcodes, one line per tab, comma = several, repeat toggle | ❌ | Needs tab state (A-3) |
| Reload Multiple Tabs with Delay | Sequential reload with a gap | 🟡 | Per-tab reload ✅. Bulk sequential reload with delay ❌ (small) |
| Duplicate selected as related in new window (menu) | Menu-editor recipe | 🖥 | Needs commands + menus (A-6) |
| Separate Tabs into Priority Groups | Priority per flow stage (queue/event/checkout/confirmation), colour by group | ❌ | Needs page-signal extractors (A-4) + tab state |
| Export Tab Information | Selected tabs → CSV | ❌ | Small once tab state exists |
| Saving Tabs If UI Crashes / Tab Studio | Visual bulk tab editor across windows | 🖥 | Out of the control plane until a UI layer exists |
| How to Generate a Tab String | Shareable tab-definition string, pasted into the URL bar | 🟡 | Session bundles carry tab URLs. A paste-able string ❌ |

### 2.2 Cookies

| Wiki page | Jancy feature | QP | Notes |
| --- | --- | --- | --- |
| Clear Cookies | Tab menu / key bind / command | ✅ | `POST /profiles/:id/cookies/clear` (partition-scoped). Command + key bind 🖥 |
| Cookie Thinger Examples | **`cookie-thinger.txt` with 5 action groups**: `del <origin> <names…>`, `delall <origin>`, `copy <n> <origin> <names…>`, `copyall <n> <origin>`; mark a tab as "cookie thinger tab n"; file hot-reload | 🟡 | We have per-call cookie list/set/clear APIs. Missing: the **file DSL**, action groups, "source tab n" slots, **copy between tabs**, and hot reload |
| Load Cookies into Partitions | CSV of cookies matched to profiles by Group+Profile or Email → loaded into open partitions | 🟡 | `POST …/cookies/load` per profile ✅. The **CSV matched across many profiles** ❌ |
| Clear cookies + hard reload selected (key bind) | Compound command | ❌ | Commands registry (A-6) |

### 2.3 Profiles

| Wiki page | Jancy feature | QP | Notes |
| --- | --- | --- | --- |
| Create Profile CSV's | Required Profile/Name/Email; optional columns | ✅ | |
| ↳ Creating Site Columns | `Site: Ticketmaster`, `Site: AXS`, custom `Site: <domain>` | 🐞 | D-3, D-4 |
| ↳ Password Resolver | `password=$literal` + 4 third-party services | 🐞 | D-2 |
| ↳ Email Code Resolver | gmail / imap + parser suffix | 🐞 | D-1, D-2 |
| ↳ SMS Code Resolver | SMS providers + parser suffix + `SMS Number` column | 🟡🐞 | SMS Number ✅. Providers ❌. Parser suffix ❌ |
| Add Profile CSVs | Profile provider from CSV, refresh button | ✅ | CSV, xlsx and Google Sheets providers |
| Selecting Profiles | Panel search, context menu by group, "Set profile…" dialog with filter and **distribution mode when tabs > profiles** | 🟡 | Console profile panel ✅. Distribution modes ❌ (only meaningful under §4's tab model decision) |
| Persist Sessions | `Persist Sessions` / `Persist Cookies` columns (1/0/blank), custom-tab checkbox, key by group+name or **email** | ➖/🟡 | QP profiles are **persistent by design** (own data dir). Missing: an **ephemeral** profile mode (Jancy's default "basic" tab), honouring those CSV columns, and "follow the email" identity keying |
| Delete/Find Stored Session Data | Manual folder deletion | ✅ | Better in QP: profile trash/restore + delete API |
| Log profile note | Selected tabs → append `timestamp,group,profile,email,url,note` to a chosen CSV; path in settings | ❌ | Small. Needs a notes-log path setting |
| Profile panel, per payment method | Autofill "details" vs "details + card n" | ✅ | `autofill/address` + `autofill/card`. Combined call 🟡 |

### 2.4 Proxies

| Wiki page | Jancy feature | QP | Notes |
| --- | --- | --- | --- |
| How do I add proxies | Per-profile `Proxy` column, `host:port[:user:pass]` | ✅ | |
| Create / Add Proxy CSV's (v2 parser) | Column-format dropdown, delimiter (comma/semicolon/colon/tab), header toggle, mode persist/start-over/random, timezone column | ✅ | P1.5 providers |
| Adding Proxies Using Bart API | Proxy provider from a vendor API (auth tokens) | ❌ | Plugin-shaped: a "remote proxy provider" interface. Bart itself is vendor-specific |
| Selecting Proxies | "Start with proxies enabled" (auto-assign from the default provider on every new tab) | 🟡 | Starred default provider ✅. **Auto-attach on launch / new profile** ❌ (setting) |
| Bulk open unique URLs with matching/random proxies | URL list → one tab per URL, each with the next/random proxy | 🟡 | bulk-open ✅. Per-URL proxy needs per-URL launch (see §4 tab model) |
| How to Test Proxies / errors 375 / 7 / 111 | Diagnostics guidance | ✅ | QP is ahead: proxy Test, egress diagnostics, named errors. Mapping Jancy's error names into our error docs is a nice-to-have |

### 2.5 Autofill

| Wiki page | Jancy feature | QP | Notes |
| --- | --- | --- | --- |
| Using Autofill | Panel / context menu / key binds ctrl+1…6 (details, details + card 1–5); **many tabs at once** | 🟡 | Address + card APIs ✅, WPM typing ✅. Multi-tab broadcast ❌. Key binds 🖥 |
| **Custom Autofill Maps** | **User-editable autofill map file**, hot-reloaded. Per-rule `url=<prefix>`; optional `traverse-shadow-doms`; lines of `<selector>; <field>[; <JS transform>]` | ❌ | **Biggest autofill gap.** See the DSL notes below and A-5 |
| 56 published site maps | Etix, MLB, TM auth/registration/OTP/checkout, AXS checkout/auth, SeatGeek payment/emailcode, FIFA, Tickets.com, Prekindle, Hollywood Bowl, artist presale sign-ups, … | ❌ | Ship our own maps for the core sites the owner uses. Not a copy of Jancy's 56 |

**Jancy's autofill-map format, as measured from all 56 published maps.**

- **Directives:**
  - `url=` (58 uses), a URL prefix.
  - `traverse-shadow-doms` (1 use).
- **Selector kinds:**
  - `id=` (174 uses), `name=` (117), `placeholder=` (17), `type=` (13),
    `aria-label=` (12), `class=`, `title=`, `autocomplete=`, `data-*=`.
  - XPath, written in backticks, such as `//label[normalize-space()=…]`.
- **Field keys, most used:**
  - Identity: `firstName`, `lastName`, `name`, `email`, `confirmEmail`,
    `password`, `passcode`.
  - Address: `address`, `address2`, `city`, `state`, `stateName`, `zip`,
    `country`.
  - Phone: `phoneNumber`, `phoneNumberLocal`, `phoneNumberAreaCode`,
    `phoneNumberLocalPrefix`, `phoneNumberLocalSuffix`, `smsNumber`.
  - Date of birth: `dob`, `dobMonth`, `dobDay`, `dobYear`.
  - Card: `ccNumber`, `ccExpDate`, `ccExpDateMonth`, `ccExpDateYear`,
    `ccCVV`.
  - Codes: `emailCode`, `smsCode`. These are **resolved codes autofilled
    into the page**, which depends on D-1.
  - Other: `free1`–`free3`, the literal `true` (to tick a checkbox), and
    quoted string literals.
- **Third column:** a JS expression over `field`, such as
  `parseInt(field)-1`, `'20' + field`, `field.substring(n, n+1)` (to split
  an OTP across digit boxes) and random picks.

### 2.6 Email integrations

| Wiki page | Jancy feature | QP | Notes |
| --- | --- | --- | --- |
| Retrieving Email Codes | Two transports: Google Workspace API, or IMAP with an app password | 🟡🐞 | Gmail OAuth ✅ (multi-account, DPAPI). IMAP ✅. Both stop at the body (D-1) |
| Gmail IMAP Setup / App Password | `imap.gmail.com:993` + app password | ✅ | Stored email accounts (Settings → Integrations) + `@alias` creds. Colon grammar 🐞 (D-2) |
| Credentials file from Google Cloud | Desktop OAuth client JSON | ✅ | Same flow |
| Error #BAD ACCT / #CONN ERROR / #INVALID GRANT / #NO SMS Number | Named inline errors | 🟡 | We use `#NO ACCOUNT`, `#API ERROR`, `#BAD ALIAS`, … Align names and add `#NO MSG` and `#NO SMS NUMBER` so users' Jancy muscle memory transfers |
| Emails Forwarded from Hotmail | Forwarding rewrites the subject (`FW:`) and moves the address into From. Needs a forward-aware parser | ❌ | Parser concern (§3) |
| Record TM Queue Positions to Google Sheets | Capture queue position → append rows to a Sheet (workspace account, sheet URL, tab name, "write test position") | ❌ | Our Sheets client is **read-only** (`spreadsheets.readonly`). Needs a write scope + an append client + queue-position capture (A-4) |

### 2.7 "Can I?" recipes (not covered above)

| Recipe | QP | Notes |
| --- | --- | --- |
| Add a delay in navigation when opening multiple tabs | ✅ | `staggerMs` on bulk-open; `launch.batchStaggerMs` |
| Append link to clipboard (web-page context menu) | 🖥 | Engine context menu, not control plane |
| Persist / Delete / Find session data | ✅/➖ | See 2.3 |
| Delete ticketcount data, soft reset, delete proxy-provider files, find directory | ✅ | QP keeps state in SQLite + dataDir, with trash/delete APIs and `GET /settings/export`. A one-click "soft reset" (wipe caches, keep profiles and settings) ❌, small |
| Dev tools for broken window / processes explained | ➖ | Engine-level. Our console + logs + `/runs` cover diagnosis |
| How to run from the command line | ✅ | `queuepilot` CLI is far richer |

### 2.8 Format strings 🖥 + data

The wiki has 9 recipes:

- profile email in the tab title
- proxy in the tab title
- event + artist
- venue + artist
- email + queue position
- profile name in the subtitle
- email/SMS code in the title
- number of selected tabs in the window title
- window name in the window title

How they work:

- Each is a **JS snippet run per tab/window**, with a documented context:
  - `ctx.tab.title`, `ctx.tab.subtitle`
  - `ctx.tab.data.ticketmaster_event.{artistName, eventName, venueName}`
  - `ctx.tab.emailCode` / `ctx.tab.smsCode` → `{value, isError}`
  - `ctx.partition.profile.{email, name, free1…}`
  - `ctx.uuid`, `ctx.name`, `ctx.title`
  - `jancy.windowManager.getWindow().getSelectedTabs()`
- They write their result to `str`.

| Feature | QP | Notes |
| --- | --- | --- |
| Tab title / subtitle / window title format strings | ❌ | Two halves:<br>(a) a **tab context model** exposing exactly this data, which is control-plane work (A-3, A-4);<br>(b) where the string is shown. The QP console Tab View can render it today. Real engine tab titles need an engine patch or extension 🖥 |

### 2.9 Custom sort (Tab View)

The wiki has four recipes:

- profile rank by `free1`
- mirror the tab bar (`a.position - b.position`)
- randomise
- queue position (`a.data.queue_it_current_position`)

| Feature | QP | Notes |
| --- | --- | --- |
| User JS comparator over tabs | ❌ | Fixed sort modes only (six, per parity-jancy.md v0.14.12). Add a "custom" sort that evaluates a user comparator over the same tab context. "Force resort" command |
| Sort/colour by priority group, queue position | ❌ | Needs A-4 data |

### 2.10 Custom key binds / custom commands / JYL

| Wiki page | Jancy feature | QP | Notes |
| --- | --- | --- | --- |
| Select default proxy provider + clear cookies + reload (`.jyl` key bind) | A compound command as a user script, bound to a key | 🟡 | JYL commands and macros ✅ (`.mjs`). Command palette ❌, key binds ❌, "selected tabs" as a command input ❌ |
| Close all tabs where queue position ≥ 30,000 | User command reading `tab.data.queue_it_current_position` | ❌ | Needs A-4 data + a tab-selection API for JYL |
| Rescan JYL directory | Hot rescan | ✅ | `POST /jyl/rescan`, `/parsers/rescan` |
| `jancy://parsers` page | Parser registry listing | ✅ | `GET /parsers` + console list |
| Menu editor (tab menu, multi-tab menu, web-page menu, app menu) | 🖥 | Console can have editable action menus. Engine menus need an engine patch |

### 2.11 Common errors

Most of these are guidance pages and map onto QP features we already have:

- **Proxy errors 375 / 7 / 111:** proxy Test plus egress diagnostics.
- **Gmail/IMAP errors:** the named resolver errors.
- **Site-specific pages (seat maps, presale dialog, SeatGeek/Tickets.com
  map, TM "prep login"):** these imply three settings we don't have:
  - **images on/off** (❌)
  - **"dismiss overlay"** (TM plugin, ➖)
  - **ctrl+click opens a related tab vs an unrelated one** (❌, needs the
    tab model)

---

## 3. Custom email & SMS parsers: what "missing phrases" really means

**The 31 email and 11 SMS wiki pages hold no parsing logic.** Each one is
the same install recipe: download `<name>.jyl`, drop it in `%appdata%\Jancy\jyl`,
rescan, then reference it in a `Site:` column. The logic is in Jancy's
attached `.jyl` files, which are Jancy's closed-source artifacts. By
handoff.md invariant #5 (Jancy: ideas only), **we do not copy them**. In
practice they also go stale every time a site changes its emails.

So the deliverable is not 42 copied files. It is:

1. **A working parser layer** (D-1, A-1) so any parser, ours or the
   user's, actually turns a mailbox into a code.
2. **A parser format at least as capable as `.jyl` parsers.** It needs:
   - the mailbox query (sender, subject, age)
   - multi-message scanning
   - forward-aware matching (Hotmail→Gmail)
   - SMS bodies
   - optional per-transport variants (Gmail vs IMAP)
3. **Our own built-in parsers for the sites that matter.** We write these
   from **real sample messages** the owner supplies (redacted), with a
   fixture test per parser. This is the real dependency: we can't write a
   correct parser for a site without one real email or SMS from it.

### Coverage target (site × transport, from the wiki's catalogue)

Status for all rows: ❌ today, because zero parsers ship in-tree.

| Site / sender | Email (Gmail API) | Email (IMAP) | Forward variants | SMS | Priority |
| --- | --- | --- | --- | --- | --- |
| Ticketmaster (US, "updated" format) | ✔ | ✔ | Hotmail→Gmail (Gmail & IMAP) | ✔ (TM SMS, TextChest) | **P0** |
| Ticketmaster UK (incl. password reset) | ✔ | ✔ | | | P1 |
| Ticketmaster Mexico | | ✔ | | ✔ | P2 |
| am.ticketmaster.com (Account Manager) | ✔ | ✔ | | | P1 |
| Live Nation | ✔ | | | | P1 |
| SeatGeek (auth) | ✔ | ✔ | | ✔ | P1 |
| AXS (via Ejoin SMS) | | | | ✔ | P1 |
| FIFA | ✔ | ✔ | Gmail→Hotmail | | P1 |
| MLB | ✔ | | | ✔ | P2 |
| LA28 | ✔ | | | | P2 |
| BestBuy (auth) | ✔ | | | | P2 |
| Dice, Fever, Fanatics | ✔ | | | | P2 |
| Seated (v1, v2), Laylo, Resy, Weverse, AEG, Fred Again, Paul McCartney (artist presale) | | | | ✔ | P2 |
| **Generic OTP** (configurable sender / subject / regex, no code) | ✔ | ✔ | ✔ | ✔ | **P0** |

**SMS transports named in the wiki:**

- SeatHero(s)
- TextChest
- Ejoin and Ejointech (SIM-bank gateway hardware)
- generic "Custom SMS parser", including SMS forwarded into Gmail or IMAP

Today QP has only the generic `webhook` resolver for SMS. Each provider
needs a resolver adapter (A-2). The **SMS-to-email-forwarding** path
(Custom SMS Parser Gmail/IMAP) works on the email pipeline once D-1 is
fixed. That is the cheapest SMS route, so it comes first.

The **generic OTP parser** is the most valuable single item. Configured
from the `Site:` column alone, it covers most of the long tail without new
code:

```
emailcode=gmail:me:otp(from=@ticketmaster.com,subject=code,re=\b\d{6}\b,maxAge=10m)
```

---

## 4. Architecture: what has to change

### 4.0 The one real structural question: tab-centric vs profile-centric

- **Jancy** is one Electron browser. A *tab* is the unit of work. A tab
  holds a partition (cookies), a profile (persona), and a proxy, and the
  user swaps profile and proxy *on a live tab*.
- **QueuePilot** is a control plane. A *profile* is the unit, and it gets
  its own engine process, fingerprint, data dir and proxy. Tabs are CDP
  targets inside a profile's run.

**Recommendation: keep profile = identity.** That is the mission: launch
identity that can be attested and whose drift is visible. Swapping a
persona or proxy on a live tab inside one fingerprinted process would break
fingerprint coherence. Map the Jancy workflows onto it like this:

| Jancy tab workflow | QueuePilot mapping |
| --- | --- |
| "Custom tabs with profiles" (N profiles → N tabs) | Batch-launch N profiles with a start URL (exists). Show them in one **cross-run Tab View** |
| Related tab (shares partition) | `relatedTo` inside one run (exists) |
| Unrelated tab | A new partition in the same run (exists), or a new ephemeral profile |
| Basic tab with no profile | **Ephemeral profile** (new: throwaway identity + temp dir, auto-trashed on stop) |
| Set profile / set proxy on a live tab | ➖ Refused by design. "Relaunch as profile X" / "rotate proxy + relaunch" instead |
| Tab passcodes / notes / data / priority | **New tab-state layer** keyed by tab id (A-3) |

**This is the decision to confirm before Phase J3.** Everything in J1–J2
is independent of it.

### A-1 Code-retrieval pipeline (fixes D-1, D-2)

```
Site column / persona field
  → Jancy-grammar adapter (password=$x, gmail:id:parser, imap:h:p:u:pw:parser, sms:key:parser)
  → transport resolver (gmail | imap | sms-provider)   returns Message[] (not a body)
  → parser.getQuery(account, ctx) narrows the transport search (from/subject/newer_than)
  → scan newest→oldest within maxAge (default 10 min), parser.parseMessage(msg, ctx)
  → first non-null code; record message-id as consumed (per profile+site) so it is never reused
  → value | named error (#NO MSG, #NO CODE, #NO ACCOUNT, #API ERROR, #NO SMS NUMBER)
```

- The transport resolvers change their return type to **`Message[]`**:
  `{id, from, to, subject, date, text, html}`. Folders become
  configurable (INBOX, All Mail, Spam).
- Parser contract v2 adds:
  - `ctx` (profile email, SMS number, site)
  - `to`/`date`/`html` on the message
  - `getQuery()` honoured per transport
- v1 parsers keep working (adapter).
- **Polling mode:** `POST /profiles/:id/resolve {wait: 60s}` re-polls every
  3 s until a code arrives. Jancy users hit "refresh code"; the console
  shows a spinner.
- A **code event on SSE**, so the console and scripts react without polling.

### A-2 SMS provider resolvers

- Common shape: `<provider>:<key|@alias>[:<parser>]`, using the profile's
  `SMS Number` (`#NO SMS NUMBER` when missing).
- Adapters for TextChest, SeatHero and Ejoin/Ejointech, each verified
  against that provider's **public API docs**. We need the owner's account
  to verify live.
- SMS-to-email forwarding needs no adapter: it is the email pipeline plus
  an SMS-body parser.

### A-3 Tab-state layer

New table `tab_state`, keyed by `tab_id` and with the tab's lifetime:

- `passcodes[]`
- `notes`
- `data` (JSON bag, written by extractors)
- `priorityGroup`
- `priority`
- `emailCode` / `smsCode` (last resolved, `{value, isError, at}`)

New APIs:

- set passcodes/notes in bulk, "one line per tab, comma = many, repeat"
- `GET /tabs` across **all** runs: the cross-run Tab View
- export the selected tabs to CSV

### A-4 Page-signal extractors (tab data)

- Plugin-shaped site extractors, run over CDP on navigation or on a short
  interval. They write to `tab_state.data`. Examples:
  - `queue_it_current_position` (Queue-it pages)
  - `ticketmaster_event` (artistName, eventName, venueName)
  - flow stage (queue / event / checkout / confirmation)
- **Priority-group rules** in settings: stage → group number.
- Optional sinks: append to a Google Sheet (needs Sheets **write** scope),
  and SSE events.
- Site-specific extractors are content. The **extractor registry** is the
  architecture.

### A-5 Autofill map engine

- `<dataDir>/autofill-maps.txt`, hot-reloaded (fs watch), using the
  format in §2.5.
- The parser is pure. It produces `Rule{urlPrefix, shadow, lines[{selector, field, transform}]}`.
- The filler runs inside the page and reuses the existing native-setter,
  event and select-matching code in `address-autofill.ts`.
- **Transforms:** the third column is user JS. Evaluate it **in the page's
  isolated world** (CDP `Runtime.evaluate` in an isolated context), never in
  the API process.
- Built-in maps fall back to today's hint-based detection.
- Multi-tab: `POST /autofill/broadcast {tabIds|profileIds, kind, card}`.

### A-6 Commands, key binds, palette (console)

- A **command registry** (server-side catalogue: id, title, input =
  selected tabs / profiles) unifies:
  - built-ins (clear cookies + reload, focus-delay navigate, export tabs,
    log note, …)
  - JYL commands
  - cookie-thinger groups
- Console: a **command palette** (ctrl+shift+space) and **editable key
  binds** stored in settings.
- Engine-window key binds and menus are 🖥.

### A-7 User expressions: format strings & custom sort

- Run **in the console page**, which is the user's own code in their own
  browser tab, against a frozen copy of the tab-context model from A-3/A-4.
- The API never evaluates them.
- Stored in settings (new `ui` section).

### A-8 Settings expansion

The current sections are `general`, `engine`, `launch`, `team`,
`integrations` and `automation`.

| New setting | Section |
| --- | --- |
| Start with proxies enabled (auto-attach the starred provider on launch or create) | launch |
| Disable images | launch (engine flag) |
| Ctrl+click opens related / unrelated tab | 🖥 engine |
| Max restorable closed tabs | launch, plus a closed-tab restore API |
| Persist sessions keyed by email | launch |
| Profile note log path | general |
| Ephemeral-by-default for profile-less launches | launch |
| Format strings, custom sort, colour-by-priority, key binds, menus | new `ui` section |
| Priority-group rules, queue-position capture, Sheets sink | new `sites` section (per site plugin) |
| Code polling: interval, max wait, maxAge, consumed-code TTL | `integrations` |

### 4.x Things that need a UI layer (🖥, honest bucket)

These live in the browser chrome, not the control plane:

- engine tab titles
- tab colours in the strip
- menu editor for engine menus
- web-page context menu
- Tab Studio
- engine key binds
- theme editor

QueuePilot's engine is the Fury Chromium fork plus a vanilla console
(ADR-0005: React console deferred). Two routes:

- **Console-first:** everything above appears in the console's Tab View.
  This is cheap and is the recommendation.
- **Engine-side:** a companion extension or patch that reads tab state and
  sets `document.title` / badge colour. This needs an ADR, and it touches
  fingerprint surface.

---

## 5. Phased roadmap

Every phase gets its own branch and ends green: API + server tests, `tsc`,
build, e2e, and a live check on a **scratch API** (never 50325).

### Phase J1: Fix the 2FA chain (defects first)

**Goal:** a real Jancy CSV yields real codes.

1. Transports return `Message[]`; configurable folders; maxAge;
   consumed-code ledger (migration).
2. Resolver→parser pipeline (A-1), parser contract v2 + v1 adapter.
3. Jancy grammar adapter (D-2): `$literal`, `gmail:id:parser`,
   `imap:host:port:user:pass:parser`, provider `key:parser`.
4. CSV import: `Site:` columns → `extra.sites`, domain-aware site matching
   (D-3, D-4). Unknown headers reported.
5. Named errors aligned (`#NO MSG`, `#NO CODE`, `#NO SMS NUMBER`, …).
6. Wait/poll resolve + SSE `code` event; console "refresh code" button.
7. In-tree parsers: **generic `otp(...)`**, **ticketmaster** (Gmail +
   IMAP), **ticketmaster-hotmail-forward**.

**Tests:** round-trip fixtures (raw RFC822 / Gmail JSON → code) per parser.
Grammar table tests. CSV fixture = the wiki's four example CSV shapes.

**Blocker:** we need redacted sample TM emails from the owner.

### Phase J2: Parser & SMS coverage

1. SMS resolver adapters: TextChest, SeatHero, Ejoin/Ejointech (A-2).
2. SMS-via-email parsers (Custom SMS Parser Gmail/IMAP).
3. P1 parsers (§3 table): TM UK, AM, Live Nation, SeatGeek, AXS, FIFA,
   with forward variants.
4. P2 parsers: on request, as samples arrive.
5. A parser test harness: `queuepilot parser test <name> <sample.eml>`.

### Phase J3: Tab-state + extractors

*Gate: owner confirms the §4.0 tab-model decision.*

1. `tab_state` table + bulk passcodes/notes + cross-run Tab View (A-3).
2. Extractor registry + Queue-it position + TM event info + flow stage
   (A-4).
3. Priority-group rules, colour by priority, queue-position sort.
4. Export tab info (CSV); log profile note (CSV append + path setting).
5. Focus-delay navigate; sequential reload with delay; unrelated duplicate.
6. Ephemeral profiles (basic-tab equivalent); Persist Sessions/Cookies
   columns honoured.

### Phase J4: Autofill maps

1. Map-file parser + hot reload + filler with shadow-DOM traversal and
   XPath (A-5).
2. Isolated-world transform evaluation.
3. `emailCode`/`smsCode` fields wired to J1, so the OTP is autofilled
   straight from the inbox.
4. Multi-tab broadcast autofill.
5. Built-in maps for the owner's core sites (TM auth/registration/
   checkout/OTP, AXS checkout/auth, SeatGeek), each with a fixture page
   test.

### Phase J5: Cookie-thinger file + cookie CSV

1. `cookie-thinger.txt` DSL (`del`, `delall`, `copy n`, `copyall n`), 5
   action groups, "source tab n" slots, hot reload.
2. Tab-to-tab cookie copy (CDP get → set across contexts/runs).
3. "Load CSV of cookies for profiles", matched by Group+Profile, else Email.

### Phase J6: Power-user surface (console)

1. Command registry + palette + editable key binds (A-6).
2. Format strings + custom sort in the console Tab View (A-7), with the
   wiki's recipes shipped as presets.
3. Settings expansion (A-8). "Start with proxies enabled". Images off.
   Soft reset.
4. Tab strings: paste-able tab definition (URL + profile + proxy
   provider + passcodes).

### Phase J7: Integrations & sinks

1. Google Sheets write scope + queue-position recorder ("write test
   position").
2. Remote proxy-provider interface (Bart-style API providers as plugins).
3. Optional engine-side tab title/colour (ADR first, 🖥 bucket).

### Order & sizing

| Phase | Size | Depends on | Unblocks |
| --- | --- | --- | --- |
| J1 | L | sample emails | everything code-related |
| J2 | M (grows with sites) | J1, provider accounts | SMS workflows |
| J3 | L | tab-model decision | J4 multi-tab, J5, J6 |
| J4 | M | J1 (code fields), J3 (broadcast) | |
| J5 | S–M | J3 | |
| J6 | M | J3 | |
| J7 | S each | J3 (data) | |

---

## 6. Test impact

- **`gmail.test.ts`, `imap.test.ts`: change shape.** They assert
  `Message[]` instead of a body. New round-trip suites cover body → code.
- **`plugins.test.ts`:** parser v2 contract + the v1 adapter.
  `resolveSiteField` gains domain-matching cases.
- **CSV import tests (`providers`):** `Site:` columns, Persist columns,
  unknown-header issues. Fixtures modelled on the wiki's example CSVs.
- **New suites:**
  - `jancy-grammar.test.ts` (table-driven)
  - `code-pipeline.test.ts` (maxAge, consumed ledger, polling)
  - `autofill-map.test.ts` (parser + filler on fixture HTML, including
    shadow DOM)
  - `cookie-thinger-file.test.ts`
  - `tab-state.test.ts`
  - `extractors.test.ts` (fixture pages)
- **Migrations:** consumed-codes ledger, `tab_state`, settings sections
  `ui` and `sites`. Each gets an up/down migration test like 001–006.
- **e2e / claims:** add an e2e that imports a Jancy CSV, sends a fixture
  email to a local IMAP fake, and asserts the profile's `emailcode`
  resolves to the code.

---

## 7. What we need from the owner

1. **Redacted sample messages** for each P0/P1 site: the raw `.eml` or the
   Gmail "Show original" text, plus SMS text. Without these, parsers are
   guesses.
2. **The tab-model decision (§4.0):** confirm profile = identity and
   ephemeral profiles for "basic tabs", or argue for in-process persona
   swapping.
3. **Which SMS providers you actually use** (TextChest / SeatHero / Ejoin /
   other), and a test key for each.
4. **Which autofill sites matter first.**
