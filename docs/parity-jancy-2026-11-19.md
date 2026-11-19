# Jancy Parity Audit: 2026-11-19 (wiki + docs)

**Sources, all read in full:**

1. **The Jancy product wiki** (Notion, `nitrane.notion.site/bef7a288…`):
   115 pages plus sub-pages. Sections: Tabs, Cookies, Profiles, Proxies,
   Autofill (56 site maps), Email Integrations, "Can I?", Format Strings,
   Custom Sort, Key Binds, Advanced, 31 email parsers, 11 SMS parsers,
   14 Common Errors.
2. **docs.jancy.io**: all 155 feature pages (everything except release
   notes), starting from `/docs/profiles/file-format` and covering the
   column specs, Site columns & resolvers, JYL tags, every Settings page,
   all 31 included plug-ins, tab management, autofill map, cookie thinger,
   and the developer structures.
3. **Release notes v1.16.0 to v1.18.0** (current), for features newer than
   the docs pages.
4. **docs.jancy.io/docs/developers** (plug-in overview, Jancy object, 22
   interfaces, 17 structures) and **github.com/nitrane** (11 public repos,
   8 of them MIT-licensed example plug-ins). See §4.y.

**Compared against:** `main` @ `e90958a` (v0.16.x, 667 API tests green).

**Companion to:** [parity-jancy.md](parity-jancy.md), the 2026-11-16
sign-off. That audit was scoped to a narrower source.

Legend: ✅ have · 🟡 partial · ❌ missing · 🐞 present but broken ·
➖ deliberately different / out of scope · 🖥 needs a UI layer (§4.x) ·
❓ owner decision (§7)

**Revision note:** the first pass of this file (commit `6a70c0c`) used the
wiki only. This revision adds docs.jancy.io, which:

- **corrects** the resolver list, the Site-matching rules and the parser
  semantics;
- **adds** about 25 feature rows;
- makes parsers **much cheaper**: the `.jyl` parser format is publicly
  specified, so users' existing parser files can be loaded directly
  (§3, A-1).

---

## 0. Verdict: parity REOPENED

The 2026-11-16 "workflow parity PASSED" does not hold against the full
documentation. There are three reasons.

1. **The 2FA code chain is broken end to end (🐞).** Resolvers and
   parsers both exist, but nothing connects them. `emailcode` resolves
   to a whole email body (§1, D-1).
2. **Jancy's CSV and resolver grammar is not accepted.** Jancy profile
   CSVs lose their `Site:` columns on import. Jancy resolver strings fail
   to parse. Thirteen third-party resolvers are absent (§1, D-2 to D-5).
3. **Large documented areas were never in scope.** For example:
   - tab passcodes and notes
   - tab data and priority (Queue-it, Ticketmaster plug-ins)
   - autofill map *files*
   - cookie-thinger *file*, with 10 groups and cookie lists
   - format strings and custom sort
   - command palette, key binds and menus
   - about 45 core settings
   - preference sets
   - queue-position capture to CSV or Sheets
   - Buyer filtering
   - Proxy Resolver
   - log profile note
   - tab strings, named windows, tab reopen

The engine, lifecycle and fingerprint layers still exceed Jancy. The
**workflow layer** is what needs the roadmap below.

---

## 1. Defects: present but wired wrong

### D-1 🐞 Resolver → parser chain is not connected

**What's wrong:**

- `gmail-resolver.ts` and `imap-resolver.ts` return the **raw text body**.
  Their comments say "the CALLER hands the text to a parser", but no caller
  does.
- `ParserRegistry` is used only by `plugin-registry.ts` and the manual
  `POST /parsers/:name/run`. `POST /profiles/:id/resolve` returns the body
  as the value.
- The tests can't see it. The gmail and imap tests assert a body comes
  back. `plugins.test.ts` tests parsing on its own. There is no body →
  code test.
- **`getQuery` is never honoured.** In Jancy, the parser *narrows the
  mailbox search* and the resolver then reads the **first** message the
  query returns. Jancy's defaults:
  - max emails per request = 1
  - an optional "only emails newer than 1 h / 2 h" filter
  - `#FILTERED MSG` when a message is rejected on age

  Reading one message is Jancy's design, not our bug. Our bug is that the
  query isn't the parser's, so the first message is just "newest unseen".
- **Gmail `label` arg is missing.** It defaults to INBOX in Jancy, and
  `#BAD LABEL` is the error.
- **The default parser is missing.** When none is named, Jancy uses
  `ticketmaster`.

**Fix:** A-1.

### D-2 🐞 Jancy resolver grammar is not accepted

**Jancy's grammar** (from `/docs/resolver-columns` and
`/docs/developers/jancy-structures/resolver`):

- **Site cell:** `<field>=<resolver[:args]>[, <next>]`. Fields are
  `password`, `smscode`, `emailcode` and `othercode`. Separator is
  comma + space.
- **Static value:** `$literal`.
- **Args are positional.** `name:one:two:three` gives
  `resolverArgs = ["one","two","three"]`.
- **Context:** the resolver receives `site ∈ {ticketmaster, axs, other}`,
  plus `url` when `other`, plus the `profile` and the `field`.

Results below are for the `Site:` column path (`resolveSiteField` → `reg.resolve`).

| Jancy | QueuePilot today | Result today |
| --- | --- | --- |
| `password=$Jancyiscool!` | `static:Jancyiscool!` | `#NO RESOLVER $Jancyiscool!`. The persona-field path returns the literal **including `$`** |
| `emailcode=gmail:ACCOUNT[:parser[:label]]` | `gmail:<account>?query=` | `#NO ACCOUNT ACCOUNT:parser` |
| `emailcode=imap:host:port:user:pass:parser` | `imap://host?user=&pass=` | `#BAD ALIAS` |
| any of the 13 third-party resolvers (D-5) | none | `#NO RESOLVER` |

**Fix:** a Jancy-grammar front end that splits args positionally and
passes `{resolverName, resolverArgs, site, url, profile, field}`. Our own
URL-style forms keep working.

### D-3 🐞 Jancy profile CSV loses columns on import

`parseProfileRows` already recognises Jancy's case-sensitive headers:

- Profile, Name, Email, Group
- Tab Color
- Address, Address 2, City, State, Zip Code
- DOB, Phone Number, SMS Number*, Passcode*, Free 1–10
- Notes, URL, Time Zone, Favorite, Proxy*
- the CC set columns (`CC Number|CVV|Exp Date|Name|Address|Address2|City|State|Zip|Note:<set>`)

**Dropped silently today:**

- **`Site:<name>`** columns: the 2FA config.
- **`Persist Cookies`** and **`Persist Sessions`** (0 / 1 / blank =
  follow the global setting).
- **`Buyer`** (comma list, filtered by the *Buyer IDs* setting).
- **`Proxy Resolver`**: a proxy fetched from a third-party API, tried
  before `Proxy`.

**Suffix handling is too strict:**

- Jancy accepts any text after `Passcode`, `SMS Number` and `Proxy`
  ("change the text following…"). Our regexes accept only digits.
- `SMS Number` supports a country code (1 or 44) in the cell or in the
  header.

**Other gaps:**

- **Duplicate group names across providers.** Jancy appends
  `(provider id)`.
- **Unknown headers** should be reported as import issues, not dropped.

### D-4 🐞 Site matching is exact-key; Jancy's is regex and ordered

| Header | Jancy rule |
| --- | --- |
| `Site:Ticketmaster` | **8** built-in domains: `ticketmaster.com/.ca/.nl/.de/.co.uk/.co.nz/.be` and **`livenation.com`**. Any subdomain (e.g. `am.`, `auth.`) |
| `Site:AXS` | `axs.com` |
| `Site:somesite.com` | becomes the regex `^.*somesite\.com.*$`, matched against the **tab URL** |
| `Site:a.com; b.com` | several patterns, semicolon-separated (v1.16.3) |
| `Site:*` | wildcard. **Columns evaluate in file order**, so `*` must come last |

We do `sites[site] ?? sites["*"]` with a free-text `site`.

**Fix:**

- Keep the Site columns as an **ordered list**.
- Implement the brand tables and the pattern-to-regex rule.
- Have resolve take `tabId` or `url`, and derive `site` from it.

### D-5 ❌ Third-party resolvers (none implemented)

**Password resolvers.** Each looks up the profile's **email**. Each uses a
marketplace or site ID that is automatic in TM and AXS columns and explicit
elsewhere:

- `1ticket:{token}[:marketplaceId]` (TM = 1, AXS = 34)
- `automatiq:token:companyId[:siteId]` (TM = 92, AXS = 276, SeatGeek = 9;
  `-999` = match the tab URL)
- `lysted:accessKey[:marketplaceId]`
- `ticketsuite:bearer[:tag]` (TM = `tmmt`, AXS = `axmt`)
- `victorylive1:user:pass:subKey[:marketplaceName]` (Ticketmaster, AXS,
  SeatGeekDirect)

**SMS resolvers.** Each uses the profile's **SMS Number**; the default
parser is `ticketmaster`, and Jancy never activates lines:

- `quick-text:key[:parser]`
- `seatheroes:key[:parser]` (and the legacy alias `seatheros`)
- `smsgateway:key[:parser]` (TelTik)
- `textchest:key[:parser]` (simple plans)
- `textchest-async:key[:parser]` (512-line plans)
- `texttrove:key[:parser]`
- `wired:key[:parser]`

All 12 accept `@alias` tokens. We have the alias store already.

---

## 2. Gap table, by area

### 2.1 Profiles & profile settings

| Feature | QP | Notes |
| --- | --- | --- |
| Required Profile/Name/Email (case-sensitive), Profile+Group unique | ✅ | |
| Optional columns: Group, Tab Color, address, DOB, Phone, SMS Number(s), Passcode(s), Free 1–10, Notes (`\n`), URL, Time Zone, Favorite, Proxy(s), CC sets | ✅ | Card type auto-detected (Visa/MC/Amex/Discover/Unknown). Check our importer does this 🟡 |
| `Site:` / Persist Cookies / Persist Sessions / Buyer / Proxy Resolver | 🐞❌ | D-3 |
| Phone Number country-code strip (leading 1) | 🟡 | Verify in J1 |
| Resolved-value timestamps (`passwordTimestamp`, …) | ❌ | Jancy shows a Timestamp field per resolved value. Our resolve returns no timestamp |
| Refresh code: panel button, context menu, palette, key binds | 🟡 | API ✅, console button ❌ |
| *Settings → Profiles:* save/restore cookies per profile | ➖ | Our profiles are persistent by design |
| ↳ key persistence by **email** vs group+name | ❌❓ | |
| ↳ flush cookies on unselect | ➖ | No live profile swapping (§4.0) |
| ↳ auto-refresh password (unresolved / domain changed) | ❌ | Needs URL-aware resolve (D-4) + extractor hook |
| ↳ auto-copy resolved value to clipboard | 🖥 | Console can do it |
| ↳ profile URL overrides Home | ✅ | Start URLs |
| ↳ Buyer IDs filter | ❌ | |
| ↳ profile note log **path** + **Google Sheet** | ❌ | "Log profile note" command |
| *Custom tab, profile mode:* filter by group / name / email (space/comma/colon/semicolon/newline lists), **exclude filter** (v1.17.5), "include in-use profiles", shuffle profiles | 🟡 | Console multi-select + batch launch ✅. List filters, exclude, in-use counts and shuffle ❌ |
| *Core:* Start with a profile selected / Use a random unused profile | ❌ | Maps to "launch next unused profile" |

### 2.2 Email & SMS codes

| Feature | QP | Notes |
| --- | --- | --- |
| Gmail resolver (Workspace OAuth, multi-account) | 🟡🐞 | OAuth ✅. Parser / label / default-parser ❌ (D-1, D-2). Jancy requires a **Workspace** account; our OAuth flow also works for consumer Gmail ✅ |
| IMAP resolver (app password) | 🟡🐞 | Same. Jancy also has IMAP **v2**: a connection pool (max connections per server, idle seconds). We open a connection per resolve |
| Settings → Email: Gmail max-per-request, "newer than" (off / 1 h / 2 h) for Gmail and IMAP | ❌ | Becomes `integrations.email` settings |
| **Error vocabulary** | 🟡 | Ours: `#NO ACCOUNT`, `#NO PASSWORD`, `#API ERROR`, `#BAD ALIAS`, `#NO RESOLVER`, `#NO PARSER`, `#PARSER ERROR`. Jancy adds `#NO MSG`, `#PARSE FAILED`, `#BAD PARSER`, `#BAD LABEL`, `#BAD ACCT`, `#OAUTH ERROR`, `#CONN ERROR`, `#FILTERED MSG`, `#BAD ARG COUNT`, `#NO SMS NUMBER`, `#NO API KEY`, `#NO MARKETPLACE ID`, `#NO MARKETPLACE NAME`, `#NO ACCOUNT FOR URL`, `#ERROR`. Adopt them verbatim so users' troubleshooting knowledge transfers |
| 13 third-party resolvers | ❌ | D-5 |
| Bundled email parsers (12): `ticketmaster`, `ticketmaster-v2` (To **or** From), `ticketmaster-gmail-hotmail`, `ticketmaster-imap-gmail`, `ticketmaster-v2-imap-gmail`, `ticketmaster-imap-hotmail`, `amex-safekey`, `diafaan-ticketmaster`, `ejoin-axs`, `ejoin-safekey`, `ejoin-ticketmaster`, `smsdeliverer-ticketmaster` | ❌ | Rewrite in-tree from the published descriptions + examples, with fixture tests (§3) |
| Bundled SMS parsers (3): `ticketmaster`, `axs`, `google` | ❌ | Trivial regexes; `google` is published in full in the docs |
| `jancy://parsers` page (description + example per parser) | 🟡 | `GET /parsers` lists name/kind/file. Add description/example and a console page |
| Clear email / SMS / other code for selected tabs (v1.17.5) | ❌ | Small, once codes are stored per tab |

### 2.3 Proxies

| Feature | QP | Notes |
| --- | --- | --- |
| Proxy file: Name?, Host, Port, Username?, Password?, Time Zone?; delimiters `, ; : tab`; header row; modes persist / start-over / random | ✅ | |
| Skip proxies that start with `#` (setting) | ❓ verify | |
| Bart API provider (auth tokens) | ❌ | Plug-in: remote proxy provider |
| Google-Sheet proxy provider | 🟡 | Profiles from Sheets ✅. Proxies from Sheets: verify |
| **Proxy Resolver** (profile column; ticketsuite also offers one) | ❌ | Proxy-resolver registry |
| Temporary proxies per tab + "max temporary proxies to save and recall" | 🟡 | Per-launch temp proxies ✅. Recall list ❌ |
| Start with proxies enabled (from the default provider) | 🟡 | Starred default ✅. Auto-attach on launch ❌ |
| Skip proxy in selected tabs (cycle the profile's proxy list) | ✅ | `POST …/proxies/rotate` |
| Drag a CSV onto the settings page | 🖥 | Console upload exists |
| Proxy timezone applied to the tab; "always overwrite tab timezone"; configurable timezone list | ✅/🟡 | Timezone follows proxy ✅ (exit-IP lookup, ahead of Jancy). Manual per-tab timezone override ❌ |

### 2.4 Tabs & windows

| Feature | QP | Notes |
| --- | --- | --- |
| New tab / related tab | ✅ | |
| Duplicate: plain / related / new window / related new window | 🟡 | Same-partition duplicate ✅. The rest ❌ |
| Custom tab, basic: URLs × count × selected tabs; related; open mode; passcodes; notes (+ copy from current); proxy provider; new window; focus last | 🟡 | bulk-open ✅. Count, passcodes, notes, provider, focus ❌ |
| **Change URL dialog**: URL list over selected tabs, **focus delay** + delay | ❌ | J3 |
| Reload: selected tabs with delay; hard reload | 🟡 | Per-tab reload ✅. Sequential and hard reload ❌ |
| Auto-reload (time options, hard reload, stop on click, focus on reload) | 🟡 | Interval ✅. Hard / stop-on-click / focus options ❌ |
| Reopen tab + max restorable | ❌ | |
| **Tab passcodes** (per tab; bulk set with one line per tab, comma = many, repeat toggle; autofill `passcode` = first unused) | ❌ | A-3 |
| **Tab notes** (per tab; copy on create; split on `=`) | ❌ | A-3 |
| **Tab priority / priority group / colour by either** | ❌ | A-3, A-4 |
| Tab colour (manual, related, priority) | 🟡 | Per-profile colour ✅. Per tab ❌ |
| Per-tab timezone override | ❌ | `Emulation.setTimezoneOverride` per target |
| Tab View: vertical list, sort orders, **custom sort fn**, resort debounce, auto sort, iteration mode | 🟡 | Console tab table + 6 sorts ✅. Custom sort ❌ |
| Tab Thinger (formula query; v1.18.0 plug-in "find tabs and do things") | ✅ | Ours already queries + bulk-closes |
| Tab Studio | 🖥 | |
| Mass select (shift / ctrl) | ✅ | Console select-all and multi-select |
| Named windows + move to named window; max tabs per window; warn above N tabs | ❌ | Window presets exist (tiling) |
| Tab strings (generate / paste) | ❌ | |
| Export info from selected tabs | ❌ | |
| Screenshot (+ filename format string) | 🟡 | Per-tab screenshot ✅. Format ❌ |
| Bookmarks | ➖🖥 | Low value for this workflow |
| Tab-creation behaviour settings (tabs created by a tab, ctrl+click, shift+click, drag link, focus new tabs) | ❌🖥 | Engine-side. Partly doable via CDP `Target.setAutoAttach` + `targetCreated` (re-home popups into related / unrelated contexts) |

### 2.5 Cookies

| Feature | QP | Notes |
| --- | --- | --- |
| Clear cookies (tab / selected / mass) | ✅ | |
| Clear TM cookies + hard reload selected (v1.16.5) | ❌ | A command (A-6) |
| Clear local storage for selected tabs (v1.17.5) | ❌ | `DOMStorage.clear` / `Storage.clearDataForOrigin` |
| **cookie-thinger.txt**: `[group 1..10]`; actions `del`, `delall`, `copy n`, `copyall n`, **`dcopy n domain`**, **lists** `lclear`/`ladd`/`lupdate`/`lcopy`; lists `1–5` temporary + `$1–$5` persistent; cookie-thinger **tabs 1–5** (set / focus); hot reload | 🟡 | Cookie list / set / clear APIs ✅. File DSL, groups, source tabs, lists, cross-tab copy ❌ |
| Load CSV of cookies for profiles into tabs (match Group+Profile, else Email) | 🟡 | Per-profile load ✅. Matched CSV ❌ |
| Cookie Viewer (save cookies to JSON) | ✅ | Cookie export formats exist |

### 2.6 Autofill

**The autofill map file (`autofill.map`).** Full spec from
`/docs/autofill/autofill-map`; QP status ❌ for the whole file:

- **Blocks:** `url=<glob>` (with `*`), then rules.
- **Block directives:**
  - `include <url>`: inherit another block's rules.
  - The implicit **`any`** block: the default rules, auto-included in
    every block.
  - `dont-include-any`
  - `traverse-shadow-doms`
  - `human f1, f2` / `machine f1, f2`: per-field fill mode.
  - `;` starts a comment line.
- **Rule:** `<attr>=<regex | "quoted">; <field | "literal" | true|1|false|0>[; <format>]`.
  - Checkboxes take the boolean constants.
  - Radios match by the field's value.
  - For a select, a format that returns a **number** picks the option by
    zero-based index.
- **Button rule:** `<attr>=<pattern>; button[; clicks]`. Runs after
  filling, in file order (v1.17.4).
- **XPath rule:** `` `xpath`; field[; format] ``.
- **Format:** a JS function body taking `(field, allFields)`.
- **About 60 profile fields:**
  - Name/contact: `firstName`, `lastName`, `name`, `email`, `notes`,
    `passcode` (first unused tab passcode).
  - Address: `address`, `address2`, `city`, `state`, `stateName`, `zip`,
    `country`.
  - DOB: `dob`, `dobDay`, `dobMonth`, `dobYear`.
  - Phone: `phoneNumber`, `phoneNumberAreaCode`,
    `phoneNumberCountryCode`, `phoneNumberLocal`,
    `phoneNumberLocalPrefix`, `phoneNumberLocalSuffix`,
    `phoneNumberNational`. The same set exists for `smsNumber*`.
  - Card: `ccNumber`, `ccNumberFormatted`, `ccType`, `ccCVV`,
    `ccExpDate`, `ccExpDateMonth`, `ccExpDateYear`, `ccNote`. Card
    address fields override the profile's.
  - Free columns: `free1`–`free10`.
  - Resolved values: `password`, `emailCode`, `smsCode`, `otherCode`,
    each with a `*Timestamp` variant.

**Autofill settings and invocation:**

| Feature | QP | Notes |
| --- | --- | --- |
| Settings: old vs new system; strip commas; fill already-populated fields; tab notification; default mode machine/human; log generated scripts; WPM, jitter, **focus delay** | 🟡 | WPM typing + jitter ✅. Mode setting, focus delay, populated-field policy ❌ |
| **Profile field swapping** | ❌ | Remap field → field (setting) |
| Invoke: details / details + card n; key binds ctrl+1…6; **selected tabs at once** | 🟡 | Address and card APIs ✅. Combined + broadcast ❌ |
| Wiki's 56 published site maps | ❌ | **Loadable directly once the map file exists**: it's the documented format (§3) |

### 2.7 Format strings, sorting, keys, menus, commands

| Feature | QP | Notes |
| --- | --- | --- |
| Format strings: window title, tab title, subtitle, **tooltip**, **profile-panel title**, screenshot filename. JS body over `ctx` (`ctx.tab.*`, `ctx.partition.profile`, `ctx.tab.data.*`, `emailCode`/`smsCode` `{value,isError}`) | ❌ | A-7. Console-rendered |
| Tab View custom sort (`a`, `b` → number) | ❌ | A-7 |
| **Command palette** (ctrl+shift+space) | ❌ | A-6 |
| **Key binds**: in-app editor + `keybinds.txt` | ❌ | A-6. Console scope |
| **Menus editor**: app / tab / multi-tab / web-page menus; menu-item JYL | 🖥 | Console action menus are doable. Engine menus need an ADR |
| JYL `<command>`, `<macro>`, `<webinterface-endpoint>` | 🟡 | We have the **`.mjs` equivalents** ✅. The `.jyl` XML forms run Jancy-object code we don't have, so they are **not** imported (refused by name) |
| JYL `<email-parser>`, `<sms-parser>` | ❌ | **Import natively** (A-1, §3) |
| Userscripts (Greasemonkey subset: `@name`, `@version`, `@include`, …) | ❌ | Inject via `Page.addScriptToEvaluateOnNewDocument` per profile. Touches fingerprint surface, so it needs a claim check |
| Preloaders (plug-in scripts injected into pages) | ❌ | Same mechanism as userscripts |

### 2.8 Site plug-ins (Ticketmaster, Queue-it, AXS, SeatGeek, Etix, …)

| Feature | QP | Notes |
| --- | --- | --- |
| **Queue-it:** queue position/progress → subtitle + priority (configurable min/max range). Domains include `queue.ticketmaster.*` (11 TLDs incl. `.se`), `queue.livenation.com`, `*.queue-it.net`, `shop.axs.com`, `queue.atgtickets.com`, `queue.paclive.com` | ❌ | A-4 extractor. **Highest-value plug-in** |
| **Ticketmaster:** cart-timer priority + subtitle (+ card name); event / cart data on the tab; logged-in user capture; dismiss overlay (opt. only on auto-reload); auto no-insurance; auto terms; original price ranges; **phrases to search event info** (border colour); **beep / sound on queue pass**; **queue-position capture** (CSV per event, Google Sheet, memory buffer; processor stats; test mode; GMT offset; username / group / profile-name columns; "track fast accounts" = -1); **priority groups per flow stage**; prep login (dead) | ❌ | A-4. Extractors: queue pass, position, cart timer, event info, stage. Page actions: overlay, insurance, terms. Sinks: CSV, Sheet, buffer |
| AXS (cart timer priority, stop waiting-room video); SeatGeek (priority groups); Etix (cart timer) | ❌ | Same extractor registry |
| Ticketcount (inventory summary on event pages) | ❌❓ | Large and site-fragile. Owner call |
| Namath purchase capture / coordination, Slack / Discord notifications, Automatiq "update password" / "sweep account" commands, broker plug-ins (Vivid Seats, StubHub, Lysted, DTI, Events for Purchase), Chaos Monkey | ➖❓ | Commercial-broker ecosystem. The 2026-11-16 audit put these out of scope; **confirm** (Q16) |

### 2.9 Settings inventory (per docs page)

| Page | Notable settings missing in QP |
| --- | --- |
| **Core** | Home page; prompt before exit; max tabs per window; max restorable; second-instance behaviour; named windows; username; on startup restore vs fresh; start with profile / random profile / proxies / **audio muted** / **images enabled** / video autoplay; tab-creation behaviours (5); focus new tabs (2); copy tab notes; multi-tab navigation delay ✅ + **focus first** + warn above N; screenshot filename; search provider; split notes on `=`; auto-reload options; timezone list + always overwrite |
| **User Interface** | Theme editor; fonts; window/tab close prompts; focus behaviour; bookmark bar; tab view open by default; iteration mode; auto sort; subtitles; colour related / priority / priority group (+ style, width); zoom; profile panel: passcode labels, hide othercode / timestamps, timestamp→local time, mask password, mask CVV, CC minimized, search result cap, dialog sorting / filtering (incl. by phone/SMS) |
| **Advanced** | Provider-load wait at startup; tab-update buffering; renderer / background throttling; hardware acceleration; extra plug-in dirs; **URL whitelist terms** (v1.18.0); clipboard read; disable WebAuthn; override `navigator.share`; preloaders/userscripts in iframes; preloader compatibility mode; **unique canvas hash per partition**; **unique audio hash per tab**; **circumvent `document.hasFocus`**; **disable Page Visibility API**; V8 cache option; **WebRTC policy**; DRM workaround; rewrite HTTP headers; bypass CORS; web interface (port, basic auth, enabled on startup); debug traces |
| **Preference sets** | Named bundles of core + advanced toggles, switchable |
| **Email** | §2.2 |
| **Autofill** | §2.6 |
| **Proxies** | Skip `#` lines; max temporary proxies recall |
| **Profiles** | §2.1 |
| **Token aliases** | ✅ (`@alias`) |
| **Google accounts** | ✅ (Sheets **read/write** scope needed for queue capture, A-4) |
| **Downloads** | Default dir; desktop notifications |
| **Import / export** | ✅ (`/settings/export|import`) |

**Fingerprint-related advanced settings** (canvas/audio hash, WebRTC
policy, `hasFocus`, visibility API) are already handled **better and at a
lower level** by the Fury engine patches: per-profile, attested. Two of
them are workflow features, not fingerprint features:

- **circumvent `document.hasFocus`**
- **disable the Page Visibility API**

They exist so background tabs don't get "Browsing Activity Paused". That
is the same problem Focus Delay solves. Map them to CDP
`Emulation.setFocusEmulationEnabled` per target (J3). No engine patch is
needed.

### 2.10 Other areas

| Feature | QP | Notes |
| --- | --- | --- |
| Network logger (net-export: strip private / include cookies / everything, max size) | ❌ | CDP `Network.*` → HAR / NDJSON per run. Medium |
| Web interface (embedded HTTP, basic auth, `/extra/<path>` endpoints) | ✅ | REST API + JYL endpoints. Ahead |
| CLI (launch, second instance opens tabs) | ✅ | `queuepilot` CLI |
| Restore factory settings / soft reset | 🟡 | Settings reset ❌ (small) |
| Google Workspace setup (Gmail + Sheets profiles) | ✅ | Consumer Gmail works too |

---

## 3. Parsers: what "missing email/SMS phrases" means now

There are four layers, in order of value.

**1. Load users' existing `.jyl` parser files natively.**

- The format is **publicly specified**: `/docs/jyl/email-parser-tag`,
  `/docs/jyl/sms-parser-tag` and the parser-registry interface.

  ```
  <jyl>
    <email-parser name="…">
      <description/> <example/>
      <can-run>…</can-run>
      <get-query>…</get-query>
      <parse-message>…</parse-message>
    </email-parser>
  </jyl>
  ```

  Each body is the body of a JS function:
  - `can-run(jancy, args)`
  - `get-query(jancy, args)`: returns a Gmail query string when
    `args.resolverName === 'gmail'`, or an **ImapFlow SearchObject** for
    imap.
  - `parse-message(jancy, args, msg)`: `msg` is a Nodemailer-parsed mail
    (`text`, `html`, `subject`, `from`, `to`, `date`).
  - SMS parsers get `msg` as a string.
- User parsers are registered as **`user-<name>`**.
- **The payoff:** every parser `.jyl` from the wiki's 42 parser pages,
  plus any the owner already has, drops into `<dataDir>/jyl` and works.
  This is interoperability with a documented file format, the same as
  accepting their CSV. It is not copying their source (handoff
  invariant #5 holds).
- **Scope:** `<email-parser>` and `<sms-parser>` only. `<command>`,
  `<macro>` and `<webinterface-endpoint>` call Jancy-object APIs
  (`tw.closeTab`, `jancy.windowManager`, …) that don't exist here. They
  are refused with a named error.
- **The `jancy` argument** gets a small shim with only `console.log`
  (used by the published examples). Anything else is undefined and
  fails loudly.
- **Trust:** parser code runs in-process, the same as our `.mjs` parsers
  and plug-ins. Only the operator can write the directory. Documented.

**2. In-tree rewrites of Jancy's 15 bundled parsers.**

- Write them from the published descriptions and examples, with fixture
  tests.
- `ticketmaster` (To) and `ticketmaster-v2` (To or From), Gmail and IMAP
  variants, the hotmail-forward variant, the three `ejoin-*`,
  `diafaan-ticketmaster`, `smsdeliverer-ticketmaster` (published in full as
  the docs example) and `amex-safekey`.
- SMS: `ticketmaster`, `axs`, `google` (published in full).

**3. The generic configurable `otp(...)` parser** covers the long tail with
no code:

```
emailcode=gmail:me:otp(from=@ticketmaster.com,subject=code,re=\b\d{6}\b)
```

**4. Site parsers from the wiki catalogue** (TM UK / AM / Mexico, Live
Nation, SeatGeek, FIFA, MLB, LA28, Dice, Fever, Fanatics, BestBuy, Seated,
Laylo, Resy, Weverse, AEG, artist presales):

- covered **first** by layer 1, the user's own `.jyl` files;
- rewritten in-tree only where the owner wants them maintained, from
  redacted samples.

---

## 4. Architecture: what has to change

### 4.0 Tab-centric vs profile-centric (owner decision, Q1)

- **Jancy:** one Electron browser. A *tab* holds a partition, a profile
  and a proxy, and profile/proxy can be swapped live.
- **QueuePilot:** a *profile* is an engine process with its own attested
  fingerprint, data dir and proxy. Tabs are CDP targets inside it.

**Recommendation: keep profile = identity.** Map the Jancy workflows onto
it:

| Jancy | QueuePilot |
| --- | --- |
| Custom tabs with profiles | Batch-launch profiles with URLs. One **cross-run Tab View** |
| Related tab | `relatedTo` in the run (exists) |
| Basic tab (no profile) | **Ephemeral profile**: throwaway identity, temp dir, auto-trash on stop |
| Persist Sessions = 1 / 0 | Persistent profile (default) / ephemeral run of that profile |
| Set profile / proxy on a live tab | ➖ "Relaunch as profile X" / "rotate proxy + relaunch" |
| Save sessions by **email** | Identity keyed by email (option) |
| Tab passcodes / notes / priority / data | **tab_state** (A-3) |

J1, J2, J4 (map parsing) and J5 (file parsing) don't depend on this
decision. J3 does.

### A-1 Code-retrieval pipeline (fixes D-1, D-2, D-5)

```
Site cell → Jancy grammar (fields, "$", positional resolverArgs)
  → ResolverArgs {resolverName, resolverArgs[], field, profile, site∈{ticketmaster,axs,other}, url}
  → parser = named | default "ticketmaster"; parser.canRun(args) else #BAD PARSER
  → transport: gmail(account,label) | imap(host,port,user,pass) | sms-provider(key, profile.smsNumber)
       query = parser.getQuery(args)   (Gmail string | ImapFlow SearchObject → IMAP SEARCH)
       fetch first N (setting, default 1) newer than (setting) → else #NO MSG / #FILTERED MSG
  → parser.parseMessage(args, msg) → code | #PARSE FAILED
  → ResolvedValue {value, isError, timestamp}  (+ consumed ledger, SSE `code` event)
```

- **Parser registry v2:** sources are `.mjs` (native) and `.jyl` (import);
  kinds are email and sms. `description` and `example` are surfaced in a
  console "Parsers" page.
- **IMAP:**
  - translate ImapFlow SearchObject keys (`to`, `from`, `subject`, `body`,
    `or`, `since`, …) to RFC 3501 SEARCH, **or** adopt `imapflow` +
    `mailparser` (decision Q15);
  - connection pool (Jancy's "v2" settings).
- **Polling:** `resolve {wait}` and a "refresh code" console action.
- **Errors:** the full Jancy vocabulary (§2.2).

### A-2 Third-party resolver adapters

- 7 SMS + 5 password providers (D-5).
- Each is a small plug-in, written against the provider's **public API
  docs** and verified live with the owner's key.
- Marketplace / site-ID tables built in, with automatic IDs in TM and AXS
  columns.

### A-3 Tab-state layer

New table `tab_state(tab_id …)` holding:

- passcodes[] (+ "used" cursor for autofill `passcode`)
- notes
- `data` JSON
- priority
- priorityGroup
- colour
- timezone override
- last resolved values `{password, emailCode, smsCode, otherCode}` as ResolvedValue

APIs:

- bulk set (one line per tab, comma = many, repeat)
- cross-run `GET /tabs`
- export selected tabs to CSV
- clear code / clear local storage

### A-4 Extractor + page-action registry (site plug-ins)

- **Extractors** run over CDP on navigation or a short interval and write
  `tab_state.data` and priority:
  - Queue-it position (domain table + priority range)
  - TM queue-pass, cart timer, event info, stage → priority group
  - AXS / Etix cart timer
  - SeatGeek stage
- **Page actions:** dismiss overlay, auto no-insurance, auto terms,
  phrase search.
- **Sinks:** CSV log (per event optional), Google Sheet (**write scope**),
  memory buffer. Processor stats; "write test position".
- **Events:** queue passed → SSE + sound in the console.

### A-5 Autofill map engine

- `<dataDir>/autofill.map`, hot-reloaded, implementing the full spec
  (§2.6).
- A built-in **`any`** block, from today's hint-based rules.
- Format functions run in an **isolated world in the page** (CDP), never
  in the API.
- Machine mode = native setter + events (exists). Human mode = existing
  WPM typer.
- Button rules run after filling.
- Field swapping.
- Broadcast to many tabs/profiles.
- The wiki's 56 maps become loadable as-is.

### A-6 Command registry, palette, key binds

- **Server-side catalogue:** id, title, input = selected tabs / profiles.
- **Contents:**
  - built-ins (clear code, clear storage, clear TM cookies + hard reload,
    change URL with focus delay, reload with delay, export tabs, log
    note, set/focus cookie-thinger tab n, run cookie-thinger group n)
  - JYL `.mjs` commands
- **Console:** palette (ctrl+shift+space) and editable key binds,
  importable from `keybinds.txt`.

### A-7 User expressions (format strings, custom sort)

- Evaluated in the **console page** against a frozen tab-context model
  shaped like Jancy's `ctx`, so the wiki recipes paste in.
- Stored in a new `ui` settings section.

### A-8 Settings expansion

- New sections:
  - `ui`
  - `sites` (per site plug-in)
  - `email` (or under `integrations`)
  - `autofill`
  - `presets` (preference sets)
- Fill them from §2.9, **owner-prioritised (Q12)**. Not all ~120 Jancy
  settings make sense for a control plane.

### 4.y Developer API + nitrane GitHub: what it fixes in A-1 to A-4

**What's on github.com/nitrane** (checked 2026-11-19). These are example
plug-ins, not Jancy's source:

| Repo | License | Use to us |
| --- | --- | --- |
| `jancy-example-resolver` | MIT | Exact resolver contract (below) + proxy resolver |
| `jancy-example-queue-position-sink` | none stated | Exact `QueuePosition` record (below) |
| `jancy-example-profile-provider`, `-proxy-provider` | MIT | Provider-factory shape (CSV / API providers) |
| `jancy-example-preloader`, `-url-handler`, `-webinterface-endpoint` | MIT / MIT / none | Preloader, URL-handler and endpoint shapes |
| `jancy-example-namath-*` | MIT | Out of scope (Q16) |
| `jyl-examples` | MIT | **Empty**: one commit, LICENSE only. The bundled `.jyl` files it promises haven't been published. Watch it; if it fills, MIT lets us vendor them with attribution |
| `node-unzipper` | fork | Irrelevant |

**Contracts this pins down.** We adopt them as-is, so Jancy plug-ins
port easily.

- **Resolver object:**
  - `{ name, resolveValue(args) → Promise<ResolvedValue | null> }`
  - `args = { field, site ∈ ticketmaster|axs|other, url, profile, resolverArgs[] }`
  - `null` means "not mine / no value", which is different from an
    `#ERROR` value.
  - `ResolvedValue = { value, timestamp?, isError? }`
  - A resolver may also implement `resolveProxy({args, profile}) → Proxy`
    to serve the **Proxy Resolver** column.
  - Our `ResolverFn(args: string) → string` becomes this. The old shape
    is wrapped.
- **Tab object** (Jancy Structures). This is the A-3 `tab_state`, field
  for field:
  - `data`, `notes`
  - `tabPasscodes[]` / `profilePasscodes[]` as `{value, used}`
  - `priority`, `priorityGroup`
  - `password` / `emailCode` / `smsCode` as ResolvedValue
  - `reloadSeconds`, `subtitle`, `timezone`, `zoomLevel`, `position`
  - `parentId`, `partitionId`, `createdTime`
- **Partition object:** `{ id, groupId, profile, proxy, proxyStr }`.
  In QP: run + partition + profile.
- **Profile object:** adds `buyers[]`, `phoneNumberFull`,
  `smsNumberFull`, `smsNumberCountryCode`, `groupName`, `profileName`,
  `proxies[]` to our persona view. These are exposed to parsers, format
  strings and autofill under the same names.
- **QueuePosition** (sink input):
  - `{ timestampMsecs, position, eventData {eventId, eventName, artistName, venueName}|null, url, emailAddress|null, proxyStr|null }`
  - Sinks receive batches.
  - Our A-4 sinks (CSV / Sheet / buffer / user plug-in) take this exact
    record.
- **Tab manager events:** `tab-added`, `tab-removed`, `tab-reload`,
  `tab-reopened`, `tab-nav-back|forward`, `tab-soft-removed`. Mirror
  these on our SSE bus so plug-ins and the console can react.
- **Jancy object:** `getInterface(key)` / `registerInterface`,
  `addURLHandler`, `addWebReadyFunction`, `registerShutdownFunc`,
  `getAppDataPath`, `readFromMemory` / `writeToMemory`.
- **Interfaces:** profileRegistry, proxyResolvers, parserRegistry,
  storeRegistry, preloaders, tabManager, windowManager, menuRegistry,
  actionRegistry, dialog / notification factories, webInterface, IPC.

**Plug-in compatibility.** Our `PluginRegistry` already has Jancy's
lifecycle under our own names:

- `queuepilotProps` ↔ `jancy_props`
- `onInit(ctx)` ↔ `jancy_onInit(jancy, enabled)`
- `onEnabled` / `onDisabled`

An optional **Jancy-plug-in shim** would cover the data-side interfaces,
all of which have QP equivalents:

- accept `jancy_*` exports (CommonJS)
- hand them a `jancy` object exposing `profileRegistry.addResolver`,
  `proxyResolvers.addResolver`, `getInterface('parserRegistry')`,
  `storeRegistry`, `console`, `axios` (fetch-backed) and a
  `ticketmasterAPI.registerQueuePositionSinkFunc`

With that, third-party Jancy **resolver / parser / sink / provider**
plug-ins run unmodified. UI interfaces (windowManager, menus, dialogs)
are refused by name.

This is an option, not a requirement (Q18). It's cheap once A-1 and A-4
exist, and it means provider vendors' Jancy plug-ins work here.

### 4.x UI-layer bucket (🖥)

Engine tab titles and colours, engine menus and context menus, Tab Studio,
engine key binds, theme editor, bookmarks, tab-creation click behaviours.

- **Route A, the recommendation:** console-first.
- **Route B:** a companion extension or engine patch, which needs an ADR
  and touches fingerprint surface. ADR-0005 (React console) is the
  related blocker.

---

## 5. Phased roadmap

Every phase gets its own branch and ends green: tests, tsc, build, e2e,
and a live check on a **scratch API, never 50325**.

### J1: Fix the 2FA chain + `.jyl` parsers *(L)*

1. Jancy grammar front end: `$`, positional args, the 4 fields.
   Ordered Site list, brand tables, pattern→regex, URL/tab-driven site
   (D-2, D-4).
2. CSV: `Site:`, Persist ×2, Buyer, Proxy Resolver, free-text suffixes,
   SMS country codes, group de-dup, unknown-header issues (D-3).
3. Pipeline A-1: parser v2, canRun / getQuery / parse, default parser,
   Gmail label, email settings (max per request, newer-than),
   `#FILTERED MSG`, ResolvedValue + timestamp, consumed ledger,
   wait/poll, SSE.
4. **`.jyl` email/sms parser import** (+ `user-` prefix, refusal of other
   tags).
5. In-tree parsers: `ticketmaster`, `ticketmaster-v2`, the hotmail-forward
   variant, IMAP variants, SMS `ticketmaster` / `axs` / `google`, generic
   `otp()`.
6. Error vocabulary; console "Parsers" page + "refresh code" button.

**Tests:**

- grammar table
- `.jyl` loader fixtures, using the docs' own published examples
- RFC822 / Gmail-JSON → code round trips
- Site-matching order
- CSV fixtures for every column

### J2: Resolver adapters *(M, grows per provider)*

- SMS adapters in the owner's order (Q4): textchest, textchest-async,
  seatheroes, smsgateway, texttrove, quick-text, wired.
- Password adapters (Q5): automatiq, 1ticket, lysted, ticketsuite,
  victorylive1.
- IMAP pool; remaining bundled parsers (ejoin ×3, diafaan, smsdeliverer,
  amex-safekey).
- `queuepilot parser test` CLI.

### J3: Tab state + workflow commands *(L; gate Q1)*

- tab_state (A-3); cross-run Tab View
- passcodes and notes (bulk); clear codes / local storage
- Change URL with focus delay; sequential and hard reload; reopen
- export tabs; log profile note (CSV + Sheet)
- ephemeral profiles; Persist columns honoured; email-keyed identity
- focus emulation (hasFocus / visibility)
- per-tab timezone override
- start-with-proxies; random / next unused profile; Buyer filtering

### J4: Autofill map file *(M)*

- Full A-5; `any` block; human/machine; buttons; XPath; shadow DOM
- field swapping; broadcast
- autofill settings
- load the wiki maps as acceptance fixtures

### J5: Cookie thinger file *(S–M)*

- 10 groups; del / delall / copy / copyall / dcopy
- lists `1–5` and `$1–$5`: lclear / ladd / lupdate / lcopy
- cookie-thinger tabs 1–5; hot reload
- cookies-for-profiles CSV

### J6: Site plug-ins *(L; extractor registry first)*

- Queue-it extractor + priority range
- TM: queue-pass, cart timer, event info, stage → priority groups;
  overlay / insurance / terms actions; phrase search
- queue-position capture → CSV / Sheet / buffer + stats + test position
- AXS / Etix / SeatGeek extractors
- Sheets write scope

### J7: Power-user console *(M)*

- command registry + palette + key binds
- format strings + custom sort (wiki recipes as presets)
- settings expansion per Q12; preference sets
- tab strings; named windows

### J8: Extras *(S each, owner-picked)*

- network logger
- userscripts / preloaders (with a claim check)
- Bart / remote proxy providers; Proxy Resolver registry
- temporary-proxy recall; soft reset
- engine-side titles (ADR)

| Phase | Size | Depends on |
| --- | --- | --- |
| J1 | L | nothing; Q2/Q3 sharpen it |
| J2 | M+ | J1; provider keys (Q4/Q5) |
| J3 | L | **Q1** |
| J4 | M | J1 (code fields); J3 for broadcast + passcode |
| J5 | S–M | J3 (selected tabs) |
| J6 | L | J3 |
| J7 | M | J3 |
| J8 | S each | as picked |

## 6. Test impact

- **`gmail.test.ts`, `imap.test.ts`: change shape.** Transports return
  messages; parsers produce codes. New `code-pipeline.test.ts` covers
  canRun, getQuery per transport, the first-N fetch, the newer-than
  filter / `#FILTERED MSG`, the default parser and the ledger.
- **`plugins.test.ts`:** parser v2 + the `.mjs` adapter.
  **New `jyl-parser-import.test.ts`:** the docs' `smsdeliverer-ticketmaster`
  and `google` examples as fixtures; refusal of `<command>`; the `user-`
  prefix.
- **`resolver-registry` / `resolveSiteField`:** ordered Site list,
  pattern→regex, brand domains incl. `livenation.com`, `*` ordering,
  semicolon multi-pattern.
- **Provider CSV tests:** every Jancy column incl. free-text suffixes,
  country codes, group de-dup, unknown headers. Fixtures from the docs
  examples.
- **New:** `jancy-grammar`, `autofill-map` (parser + filler on fixture
  HTML incl. shadow DOM, select-by-index, radio, buttons, include/any),
  `cookie-thinger-file`, `tab-state`, `extractors` (fixture Queue-it / TM
  pages), resolver adapters (recorded HTTP fixtures).
- **Migrations:** consumed ledger, tab_state, settings sections. Each gets
  an up/down test.
- **e2e:** import a Jancy CSV → local IMAP fake → `emailcode` resolves to
  the code.

## 7. Questions for the owner

Answer by number.

1. **Tab model.** Keep profile = identity (one engine per profile), with
   ephemeral profiles standing in for Jancy's "basic tabs", and no live
   profile/proxy swapping on a tab? (yes / no / discuss)
2. **Existing `.jyl` files.** Do you have Jancy parser `.jyl` files
   (from the wiki or Jancy support) you want to drop in? Roughly how many,
   and for which sites?
3. **Email transport.** Do your code mailboxes use a Google **Workspace**
   account (Gmail API), **IMAP app passwords**, or both? Which providers
   (Gmail, Outlook/Hotmail, Yahoo, other)?
4. **SMS providers.** Which do you actually use: TextChest (simple or
   512-line async), SeatHeroes, SMSGateway/TelTik, TextTrove, QuickText,
   Wired, Ejoin / Diafaan / SMSDeliverer forwarding to email? In priority
   order.
5. **Password services.** Do you use Automatiq, 1Ticket, Lysted,
   TicketSuite or Victory Live for account passwords, or only static `$`
   passwords?
6. **Sample messages.** For the sites you care most about, can you send
   one redacted raw email ("Show original") or SMS text each? Only needed
   for parsers you have no `.jyl` for.
7. **Sites, in priority order.** TM US / UK / MX, Live Nation, AXS,
   SeatGeek, Etix, FIFA, MLB, others?
8. **Queue-position capture.** Needed? Output to CSV, Google Sheet, or
   both? Which extra columns (username, group, profile name)?
9. **Ticketmaster page actions.** Want any of: dismiss overlay,
   auto no-insurance, auto terms, phrase search, beep on queue pass, cart
   timer in the subtitle?
10. **Autofill.** Which sites/pages first? Do you have an existing Jancy
    `autofill.map` to import?
11. **Cookie thinger.** Do you use it today? Do you have a
    `cookie-thinger.txt` to import?
12. **Settings priority.** From §2.9, which settings do you actually use?
    At minimum: start with proxies, images on/off, audio muted,
    multi-tab delay + focus first, random/next profile, auto-reload
    options. Is anything else critical?
13. **Format strings / custom sort / key binds.** Do you rely on any? If
    so, paste them so they become presets.
14. **Persist Sessions semantics.** Do you need email-keyed sessions
    (same session across profile renames), or is group+name fine?
15. **Mail library.** OK to add the `imapflow` + `mailparser` npm
    dependencies so `.jyl` IMAP queries (ImapFlow SearchObjects) work
    exactly? The alternative is hand-translating them in our own IMAP
    client.
16. **Out of scope confirm.** Namath purchase capture/coordination,
    Slack/Discord notifications, broker plug-ins (Vivid Seats, StubHub,
    Lysted listing, DTI, Events for Purchase), Ticketcount inventory:
    still out of scope?
17. **Order.** Run J1 first? Or do you want J6 (Queue-it / TM
    extractors) earlier, since it's the most visible?
18. **Jancy plug-in shim.** Do you run any third-party Jancy plug-ins
    (provider-supplied resolvers, proxy providers, queue-position sinks)
    you'd want working unmodified? If yes, which? (This decides whether
    the §4.y shim is built in J2 or parked.)
19. **Proxy Resolver.** Does any provider give you per-profile proxies
    via an API (the Proxy Resolver column)? Which one?
20. **Profile source.** Do you load profiles from CSV files, Google
    Sheets, or the arc2 profile provider (named in Jancy's token-alias
    docs)?

---

## 8. Owner answers (round 1, 2026-11-19) and the resulting scope

The answers are in [jancy-owner-questions.md](../jancy-owner-questions.md).
Follow-ups and explanations are in
[jancy-owner-questions-round2.md](jancy-owner-questions-round2.md).

| Q | Answer (summary) | Effect on the plan |
| --- | --- | --- |
| 1 Tab model | Round 1: "profiles I create must stay until I delete them". **Decided 2026-11-19:** "not its own browser *window*, its own **tab**: one container instead of 10–20 taskbar windows" | Profile = identity stays (persistent, own engine, own locked IP; ephemeral only on request). The **look** the owner wants comes from the **Profile Deck** (ADR-0008): one container window with a tab per running profile; engines stay separate processes. Step 1 = taskbar grouping (quick win); step 2 = Deck spike, which must pass the claim suite. **J3 unblocked** |
| 2 `.jyl` files | None | The `.jyl` loader stays in J1 (cheap; the wiki's parser files can be downloaded later). **In-tree parsers become the main path**, so samples matter (round 2, R2-1) |
| 3 Email | Gmail + **AYCD** | New **`aycd` resolver** (AYCD Inbox Mail Tasks API: filters + elements → code; Inbox must be running locally) in **J1**, next to gmail and imap. Our `otp(...)` parser maps 1:1 onto AYCD mail filters/elements |
| 4 SMS | All seven + Ejoin / Diafaan / SMSDeliverer | J2 builds all seven adapters, plus the ejoin / diafaan / smsdeliverer email parsers in J1–J2. Evaluate a **generic schema-driven SMS adapter** (AYCD's documented Custom SMS Schema JSON shape) to cut per-provider code |
| 5 Passwords | All five + TM / AXS / MLB sites | J2 builds all five. Add **MLB** as a brand table next to Ticketmaster and AXS (Site matching) |
| 6 Samples | "Tell me what you need" | Exact list in round 2 (R2-1) |
| 7 Sites | All listed **except FIFA** | FIFA parsers and maps dropped. Order: TM US/UK/MX, Live Nation, AXS, SeatGeek, Etix, MLB |
| 8 Queue log | Yes, CSV + Sheet + all columns | J6 full queue-position capture; Sheets **write** scope |
| 9 TM actions | All | J6 full TM plug-in |
| 10 Autofill | Unsure; is there code to build on? | Yes: the published map format + 56 wiki maps as fixtures + our existing fill/typing code. J4 unchanged; explained in round 2 |
| 11 Cookie thinger | Unsure; has own **cookie warmer** (repo `Randomz`) | The cookie thinger is **not** a warmer (round 2). J5 stays. **Import the owner's warmer**, found locally at `C:\multilogin\mlxwarmup\mlx-warmup` (Warmup Console for Multilogin X: persona JSON, Google-search arrival, banner accept, log-normal dwell, scroll bursts, same-site clicks, login/cart filter, batches over days, CDP-driven). Port its browsing engine + personas as a **persona mode** in QP warmups, swapping the MLX launcher for QP lifecycle. Record/replay stays (R2 B4) |
| 12 Settings | Wants all the listed ones | Core launch settings move into **J3**, the rest into J7 |
| 13 Format/sort/keys | **Decided:** tab label shows **email (or profile name) + queue position**. Artist name and 2FA codes are NOT shown; codes work in the background. Plug-in style extensibility "when needed" | Default tab-label format = `email · queue position` (Deck tab strip + console Tab View). Codes feed autofill only. Other presets / custom sort / key binds stay available in J7, off by default |
| 14 Sessions | "Save sessions per profile" | QP keys a profile's data by its internal **id**, so renames already keep the session. No email-keying needed. Explained in round 2 |
| 15 imapflow + mailparser | Yes | Adopted in J1 |
| 16 Out of scope | Keep out, **except Discord notifications + cookie/IP export to Discord** | New **J6.5 Discord**: webhook-first (bot only if replies/commands are wanted), events (queue passed, position captured, code resolved / failed, launch / crash), and an **opt-in cookie + exit-IP export** to a private channel. Security notes in round 2 |
| 17 Order | "sure" (J1 first) | J1 → J2 → J6 (+ Discord) → J3 → J4 → J5 → J7 → J8. J3 moves after J6 only if J6 doesn't need tab state; if it does, J3's tab-state slice moves forward |
| 18 Jancy plug-in shim | Unsure | Parked (J8). Scenarios in round 2 |
| 19 Proxy resolver | **Decided:** "once we create a profile, that profile sticks with that IP going forward" | **Sticky IP is the rule.** An attached static proxy already stays (ADR-0007: "stable by design"). Gap: a profile attached to a **rotation link** gets a new endpoint per launch, which breaks "locked". New item **P-LOCK**: link/provider proxies resolve **once** and are pinned to the profile (re-roll only by explicit operator action, logged in the snapshot). Rotation-per-launch stays available for warmups and throwaway profiles only. Jancy's Proxy Resolver → J8 |
| 20 Profile source | CSV + Sheets + **arc2** | CSV and Sheets ✅. **arc2 provider** ❌: needs API docs / an account (R2-5) |
