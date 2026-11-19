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

## Next, in order

1. J1 slice B: the resolver→parser pipeline. Jancy grammar for
   `gmail:acct[:parser[:label]]` and `imap:host:port:user:pass:parser`;
   imapflow + mailparser (owner approved); canRun / getQuery /
   parseMessage; default parser `ticketmaster`; "newer than" setting;
   ResolvedValue + timestamp; Jancy error vocabulary.
2. J1 slice C: `aycd` resolver, `.jyl` email/sms parser loader (only those
   two tags), in-tree TM/AXS/SeatGeek/MLB + SMS parsers, generic `otp()`.
3. P-LOCK, then W (warmer port), then J2, then J6 (+ Discord), then
   DECK spike, then J3 …

## Rules that still apply

- Never commit to `main`; push only when the owner says so.
- Live checks only on a scratch API (own port + data dir), never :50325.
- `git add` specific files in the worktree. `npm install` dirties
  `package-lock.json`; don't commit that.
