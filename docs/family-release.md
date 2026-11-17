# Family release — updates, packaging and profiles that follow you

Status: plan (2026-11-18, branch `phase-ab`). Owner decisions are listed
explicitly at the end of each part and are **not** assumed anywhere below.

The gap: a family member cannot `git pull` and `npm install`. Today a
machine needs a git checkout, Node.js 22+, `npm install` on an NTFS volume,
and the engine installed by hand. Updates are the same steps again.

## What exists today

| Piece | Where | State |
| --- | --- | --- |
| One-double-click start | `scripts/start-queuepilot.cmd` | Starts the API minimized (`npx tsx src/main.ts`), waits for `/health`, opens the dashboard. Needs Node + an installed checkout. |
| Engine packaging | `scripts/publish-engine.mjs`, `scripts/package-installer.ps1` | Builds a `.tar.xz` + manifest entry (sha256, size), or a self-installing zip (`setup.ps1` + payload). |
| Engine install / update | `queuepilot engine install` / `engine update` (`apps/api/src/cli/engine-*.ts`, `EngineInstaller`) | Checksummed, atomic, consent-gated (`--yes`), previous version kept for rollback. CLI only until this branch. |
| Engine manifest | `engines.manifest.json` (repo root) | One entry, `url: file:///C:/queuepilot-engine/dist/…` — only resolvable on the build machine. |
| Engine consent setting | Settings → Engine → "Allow engine binary downloads" (`engine.downloadConsent`) | Exists, was not consulted by anything. |
| Session bundles | `/profiles/:id/bundle/export`, `/bundles/restore` | Encrypted (PBKDF2 + AES-256-GCM), passphrase-protected; cookies today; restore upserts the profile by name. |
| Team sync | `TeamSyncService` + `apps/server` | Push/pull of the same bundles through a self-hosted server. Needs a server. |

## C1 — App updates

### Options

**(a) git fetch + reset behind an "Update" button.**
The API runs `git fetch`, `git reset --hard origin/<branch>`, `npm ci`, then
restarts itself.

- + No release process; every pushed commit is immediately available.
- − Every family machine needs git *and* a working npm toolchain (native
  `better-sqlite3` build or prebuilt download, which fails on FAT32 volumes
  and behind some AV).
- − `reset --hard` destroys any local edits; a broken `main` reaches every
  machine at once; the API would be replacing its own running files.
- − An endpoint that runs git and npm is a code-execution surface; it would
  have to sit behind the same gate as scripting (token + opt-in), which the
  dashboard cannot reach today (see roadmap B3b).

**(b) Download a release zip from GitHub (recommended).**
A release is a zip with the app *already installed* (`node_modules`
included, prebuilt `better-sqlite3` for win-x64), plus its sha256. The
updater downloads it, verifies the checksum, unpacks next to the current
version (`app/<version>/`), switches a `current` pointer, and restarts.

- + No git, no npm, no compiler on family machines — only Node.js (or, later,
  a bundled Node).
- + Same discipline as the engine: pinned checksum, atomic switch, previous
  version kept, one-step rollback.
- + Only tagged releases reach family; a bad commit on `main` does not.
- − Needs a release step (CI or a script) and somewhere to host the zips.
- − A zip with `node_modules` is ~100 MB; updates are whole-zip.

**Recommendation: (b).** It is the engine installer's proven model applied to
the app, and the only option that removes git/npm from family machines.

### What can be built without an owner decision

Not much, honestly: every concrete step of (b) depends on where releases
live and who builds them. This branch therefore implements the engine half
(below) and leaves app updates as this plan. The start script needs no change
until (b) exists: it would point at `app\current\apps\api` instead of the
checkout.

## C1 — Engine updates (implemented on this branch)

The checksummed installer already existed but only as a CLI. The dashboard
now offers it the same one-click way, with no new infrastructure:

- `GET /engine/update` — reads the engine manifest (default: the repo's raw
  `engines.manifest.json`; override `SPECTRA_ENGINE_MANIFEST`), picks the
  newest entry for this platform, and reports `current` / `available` /
  `error`, plus the state of any running install.
- `POST /engine/update` — starts the install in the background (202). It is
  refused unless **Settings → Engine → Allow engine binary downloads** is on
  (the existing consent switch), refused while another install runs, and
  refused for browser-originated cross-site requests. The download goes
  through `EngineInstaller`: sha256-pinned, atomic, previous version kept.
- Dashboard: Settings → Engine shows the check result and an "Install
  update" button with live status.

What still blocks family use: the manifest's `url` is `file:///` on the build
machine (owner decision below).

## C2 — Profiles that follow you (proposal, not implemented)

### Simplest family-grade flow: a sync folder

1. Settings gets a **sync folder** (e.g. the OneDrive / Google Drive desktop
   folder that already syncs between the family's machines).
2. When a profile **stops**, QueuePilot exports its session bundle
   (encrypted) to `<sync folder>/<profile name>.qpbundle`. Export needs the
   profile running (cookies live in the engine), so the export happens in
   the stop path, just before the engine closes.
3. On the other machine, the Profiles view shows "N profiles in your sync
   folder are newer than here — restore?" and calls the existing
   `/bundles/restore` for each.

No server, no account: the cloud drive the family already uses does the
transport; the bundle format, crypto and restore logic already exist.

### Why not implemented here

- It needs the bundle **passphrase** at stop time without a human typing it.
  That means storing it (DPAPI SecretStore, per machine) — a security
  decision, not a default to guess.
- Bundles carry cookies only today; localStorage/IndexedDB are "later" in
  `session-bundle.ts`. Whether cookies alone are enough for the family's
  sites decides whether this is worth shipping before storage lands.
- Two machines running the same profile at once would race; the team server
  has revisions for that, a folder does not. A "last stopped wins" rule plus
  a visible timestamp is the simple answer — but it is the owner's call.

The team sync server remains the right answer when more than one person
actively uses the *same* profile; the folder flow is for "my profiles on my
two computers".

## Owner decisions

1. **Where releases live** — GitHub Releases on the (currently public?)
   repo, a private repo with a token, or a shared drive. Determines the
   manifest URLs for both the app and the engine.
2. **Who builds a release** — a GitHub Actions workflow (CI minutes, signing
   secrets in CI) or a local script on the build machine.
3. **Engine hosting** — the 283 MB engine tarball cannot live in git; it
   needs the same host as (1). Until then the manifest stays `file:///`.
4. **Auto vs manual update** — check on start and install silently, check
   and *offer*, or only on click. This branch implements *offer + click*.
5. **Update channel** — Settings already has `engine.channel`
   (stable/beta); does a beta channel exist for the app too, and who is on
   it?
6. **Bundled Node.js** — ship a portable Node in the release (no
   prerequisite, +30 MB) or keep "install Node 22 first".
7. **Code signing** — the engine package is unsigned (SmartScreen/AV
   warnings, `docs/av-notes.md`). Buy a certificate, or keep documenting AV
   exclusions.
8. **Sync folder (C2)** — wanted at all; may the bundle passphrase be stored
   per machine (DPAPI) so export-on-stop runs unattended; conflict rule.
9. **Dashboard auth (B3b)** — needed before any code-running or
   update-the-app button can live in the dashboard of a token-protected
   install.
