# Update for Kimi: Jancy parity workstream (2026-11-19)

From: Claude Code session, D:\QueuePilot. Read this before touching the
Jancy work.

## Branches, not pushed (owner pushes / merges)

| Branch | Where | What |
| --- | --- | --- |
| `jancy-wiki-audit` | `D:\QueuePilot` | Docs only: parity audit, roadmap J1–J8, owner Q&A |
| `jancy-j1` | worktree `C:\Users\colli\qp-worktrees\jancy-j1` (D: is FAT32, so npm can't install there) | Built on `jancy-wiki-audit`, plus J1 slice A code, ADR-0008 and this note |

`main` is untouched. The live API on :50325 is untouched; nothing was
restarted or deployed.

## What changed

### 1. Audit: Jancy parity reopened

See `docs/parity-jancy-2026-11-19.md`. The 2026-11-16 "PASS" didn't hold
against the full sources:

- the Jancy wiki (115 pages)
- docs.jancy.io (155 feature pages + v1.16–1.18 release notes + developer
  API)
- github.com/nitrane (MIT example plug-ins)

**Key defect, D-1:** the gmail/imap resolvers return a raw email body,
and nothing runs a parser on it, so `emailcode` never yields a code.

### 2. Owner answers

- Report §8; raw answers in `jancy-owner-questions.md` (repo root).
- Round-2 explanations and follow-ups are in
  `docs/jancy-owner-questions-round2.md`. Open: samples, AYCD use,
  Discord, arc2, warmer details.

**Decisions:**

- **One container window with a tab per running profile** (not new
  windows). Engines stay separate processes, see
  `docs/adr/0008-profile-deck-container.md` (proposed; a spike must pass
  the claim suite).
- **Tab label = email + queue position.** 2FA codes stay in the
  background.
- **A profile keeps one locked IP** (new roadmap item P-LOCK).
- **The owner's Multilogin warmer** (`C:\multilogin\mlxwarmup\mlx-warmup`)
  becomes QP's warmup engine (roadmap item W).
- **In scope:** AYCD Inbox as a code source, all 7 SMS + 5 password
  resolvers, TM / AXS / SeatGeek / Etix / MLB (no FIFA), full TM plug-in +
  queue logging, Discord notifications + opt-in cookie/exit-IP export,
  arc2 profile provider.
- **Out of scope:** Namath, Slack, broker plug-ins, Ticketcount.

### 3. Code: J1 slice A (`jancy-j1` @ `4982f1f`)

- `packages/contracts/src/providers.ts`, CSV import:
  - Jancy `Site:<x>` columns, in file order
  - `Persist Cookies` / `Persist Sessions` (1/0/else = null)
  - `Buyer`, `Proxy Resolver`
  - any text after `Passcode` / `SMS Number` / `Proxy`
  - SMS country code (+1/+44) taken from the header or the cell
  - leading US `1` stripped from Phone Number
  - unknown (case-mismatched) headers reported as issues
- `provider.service.ts` `extraOf`: the new keys are stored in
  `profile.extra` only when present.
- `resolver-registry.ts`:
  - `$literal` static values
  - Jancy positional `ctx.resolverArgs`
  - `ctx.siteKind` / `ctx.url`
  - Site cells split on `, field=`
  - `matchSiteColumn` / `resolveSiteFieldForUrl`: brands (Ticketmaster
    incl. livenation, AXS, MLB), then custom columns in file order, `*`
    last.
  - **Host matching is at label boundaries** (`hostMatchesDomain`), on
    purpose: safer than Jancy's substring rule, so look-alike hosts never
    get a resolved password. Patterns containing `/` keep Jancy's
    whole-URL match.
- `plugins.routes.ts`: `POST /profiles/:id/resolve` accepts `url`, which
  wins over `site`.
- Tests: `apps/api/tests/jancy-grammar.test.ts` (17 tests).
- Gates: typecheck, build, **684/684 API + 20/20 server** green. Codex
  second-opinion: no blocking issues; its `host.includes` note was fixed.
- **Live-verified 2026-11-19** on a scratch API (:50477, own data dir;
  stopped afterwards by its PID). Results are in the roadmap box.

### 4. Code: J1 slice B (`jancy-j1` @ `5156fab` + `d2e648d`). Fixes D-1

**New files:**

- `application/email/code-pipeline.ts`: the pipeline. Parser (default
  `ticketmaster`) → canRun → transport.fetch(getQuery) → newer-than
  window → parseMessage, newest first. Jancy error names.
- `application/email/imap-flow-transport.ts`: imapflow + mailparser.
  Implicit TLS only on 993; other ports plain + STARTTLS.
- `application/parsers/builtin-parsers.ts`: `ticketmaster`,
  `ticketmaster-v2`, `smsdeliverer-ticketmaster`, `sms-ticketmaster`,
  `sms-google`. All written from Jancy's published docs.

**Changed files:**

- `parser-registry.ts`: contract v2.
  - `args` = Jancy Resolver object.
  - Email `msg` = parsed mail; SMS `msg` = text. v1 `.mjs` parsers still
    get their old shapes.
  - `list()` shows source / description / example.
  - `rescan()` only replaces user parsers.
- `gmail-resolver.ts`: `gmail:acct[:parser[:label]]` returns a code.
  `?query=` keeps the raw body.
- `imap-resolver.ts`: `imap:host:port:user:pass:parser` and
  `imap:<stored-account>:<parser>` return a code. The raw forms are
  unchanged.
- `resolver-registry.ts`:
  - `resolverArgs` are split before alias expansion, so an `@alias`
    secret containing `:` stays whole.
  - The context carries `profile.name` and `profile.smsNumber`.
- Settings `integrations`: `emailGmailMaxPerRequest`,
  `emailGmailNewerThan`, `emailImapNewerThan`.
- `POST /profiles/:id/resolve` returns `isError`.
- Deps: `imapflow`, `mailparser`, `@types/mailparser` (owner approved).

**Gates and checks:**

- Typecheck, build, **704/704 API + 20/20 server** green.
- Live-verified on a scratch API against a real IMAP server; details are
  in the roadmap box.
- **Open:** the TM email code regex must be checked against the owner's
  sample emails. The Gmail path is only verified with a mocked Gmail API.
- One full `npm test` run reported 81/82 files with no failure listed; two
  reruns were green. A possibly flaky test; watch for it.

### 5. Code: J1 slice C part 1, AYCD Inbox (`da3c003`)

**Files:**

- `application/email/aycd-inbox.ts`:
  - `AycdInboxClient`: `POST /api/v1/tasks/mail/create`, `GET
    /api/v1/tasks/completed?group=…`, `Authorization: Token <key>`;
    contract taken from AYCD's public JS client.
  - `runAycdCodeTask`, `registerAycdResolver`, `safeAycdBase`,
    `redactAycdKeys`.
- Parsers get an optional `aycdTask(args)` → `{ mailFilters,
  mailElements, resultElements }`. AYCD never returns the body. Builtin
  `ticketmaster` has one, with RE2-safe regexes.
- Settings `integrations`: `emailAycdLookbackMin` (10),
  `emailAycdTimeoutSec` (60).
- Env `SPECTRA_AYCD_API_BASE`: https or loopback only. Used for the live
  fake.

**Usage for the owner:**

- **Store the Inbox API key as an alias:** `PUT /aliases/aycd`. This needs
  scripting endpoints on, plus `SPECTRA_API_TOKEN`.
- **In the CSV:** `emailcode=aycd:@aycd`. Add `:<parser>:<templateId>`
  for catch-all or forwarding accounts.
- **Or use AYCD's IMAP Server:**
  `emailcode=imap:127.0.0.1:<port>:<account email>:<password>:ticketmaster`.

**Audit:**

- **No Codex any more.** The owner asked for in-house audits: the
  `security-auditor` agent plus a Claude review. The agent's verdict was
  CLEAR. Four fixes are in this commit; two pre-existing follow-ups are
  roadmap item **SEC-1**.
- AYCD knowledge bank `D:\aycd-knowledge\01-inbox-tasks-api.md` was
  updated with the HTTP contract and the Inbox services overview.

**Gates and checks:**

- Typecheck, build, **713/713 API + 20/20 server** green.
- Live: scratch API → local fake Inbox API (details in the roadmap). Not
  yet tried against the owner's real Inbox.

### 6. Agreed build order + SEC-1, AYCD complete, `.jyl` loader, parsers

**Owner agreed the order** in `docs/roadmap.md` (Jancy section): five
milestones, SEC-1 first, J3a tab-state core before J6, and DECK is GO after
its test build.

**What landed:**

- **SEC-1:**
  - `/profiles/:id/resolve` needs `SPECTRA_API_TOKEN` (403 otherwise).
  - `ctx.usedAliases`: `webhook` refuses stored secrets; `imap` sends
    `@alias` passwords only to trusted hosts (`TRUSTED_IMAP_HOSTS` +
    stored-account hosts).
- **AYCD complete:**
  - `/integrations/aycd` key slot (save / verify / remove).
  - Console card in Settings → Integrations.
  - The owner submits the real key next, with Inbox open.
- **`.jyl` loader:** `application/parsers/jyl-parser-loader.ts`. Only
  `<email-parser>` and `<sms-parser>`; files go in `<dataDir>/parsers`;
  names become `user-<name>`.
- **Parsers:**
  - TM US verified against the owner's real mail format (redacted
    fixtures in `tests/parser-fixtures.test.ts`).
  - Generic `otp(...)` + `lookupParser()` in `builtin-parsers.ts`.
  - No AXS / SeatGeek / MLB / Etix / TM UK / TM MX samples exist in the
    owner's Gmail, so those sites use `otp()`.

**Commit and audit:**

- Commit `4c7b997`. Gates: **738/738 API + 20/20 server**.
- In-house audit, two passes: CLEAR. Also fixed in this commit:
  - `static` refuses `@aliases`;
  - `env:` reads only `QP_VALUE_*`;
  - an aliased IMAP password needs TLS to remote hosts;
  - the `.jyl` header parser no longer has a ReDoS risk.
- Accepted as-is (consistent with `/email-accounts`): `PUT /integrations/aycd`
  has no scripting gate.

**⚠ Secret-store isolation:** scratch APIs MUST set `QUEUEPILOT_DATA_DIR`
as well as `SPECTRA_DATA_DIR`. Without it they share the LIVE DPAPI store.
A fake `aycd` alias leaked there on 2026-11-19 and was removed. The code
change is an owner decision, tracked as roadmap **SEC-2**.

## Next, in order

1. J2 service connectors: 7 SMS + 5 password. Built from the providers'
   public API docs; live verification needs the owner's test keys.
2. P-LOCK, then W (warmer port).
3. J3a tab-state core, then J6 (+ Discord), then DECK (test build, then
   build; owner GO).
4. J3b, J4, J5, J7, J8.

## Rules that still apply

- Never commit to `main`; push only when the owner says so.
- Live checks only on a scratch API, never :50325. Give it its own port
  AND its own data dir, set through **both** `SPECTRA_DATA_DIR` and
  `QUEUEPILOT_DATA_DIR`.
- Audits use the in-house tools (security-auditor agent + Claude review),
  not Codex.
- `git add` specific files in the worktree. `npm install` dirties
  `package-lock.json`; don't commit that.
