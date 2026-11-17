# Team release — updates from the owner's server, and profiles that follow you

Status: plan + client-side implementation (2026-11-18, branch `phase-ab`).
Framing follows the roadmap track **"Hosted team deployment (owner-directed
2026-11-17)"**: the owner's server (Ubuntu, ≤ 10 team members) hosts app
releases and engine dists; team members' machines are pure consumers that
check at launch, download, verify and restart. This file keeps the name the
Phase A+B brief gave it; the people it serves are **team members**.

Owner decisions are listed at the end and are **not** assumed anywhere.

## What exists today

| Piece | Where | State |
| --- | --- | --- |
| One-double-click start | `scripts/start-queuepilot.cmd` | Starts the API minimized (`npx tsx src/main.ts`), waits for `/health`, opens the dashboard. Needs Node + a checkout with `node_modules`. |
| Engine packaging | `scripts/publish-engine.mjs`, `scripts/package-installer.ps1` | Builds a `.tar.xz` + manifest entry (sha256, size), or a self-installing zip. |
| Engine installer | `EngineInstaller` (`apps/api/src/application/engine/`) | Checksum-pinned (sha256), atomic (staging + rename), previous version kept → rollback by deleting the new receipt. |
| Engine manifest | `engines.manifest.json` | One entry, `url: file:///C:/queuepilot-engine/dist/…` — resolvable only on the build machine. |
| Session bundles | `/profiles/:id/bundle/export`, `/bundles/restore` | Encrypted (PBKDF2 + AES-256-GCM), passphrase-protected; cookies today. |
| Team sync server | `apps/server` + `TeamSyncService` | Encrypted bundle push/pull, revisions, launch leases, three roles. |

## C1 — Update distribution, CLIENT side (implemented on this branch)

What a team member's machine does now, for the **engine**:

1. **Version check at launch.** When the API starts it reads the engine
   manifest once (off the startup path — an unreachable server never delays
   boot) and logs `engine update available: fury-core <v> (from <url>)`.
   The dashboard's setup checklist shows "engine update <v> available —
   Settings → Engine to install". It never downloads by itself.
2. **Configurable server URL.** Settings → Engine → "Update server URL" —
   the owner's server URL of an engines manifest. Precedence: that setting
   → `SPECTRA_ENGINE_MANIFEST` → the repo's raw manifest. http(s) only.
3. **Download + checksum verify.** Settings → Engine → "Install update"
   (requires the existing "Allow engine binary downloads" switch) runs the
   `EngineInstaller` in the background: sha256-pinned, atomic, resumable
   download, previous version kept. A mismatch discards the payload and the
   job reports `checksum mismatch`.
4. **Restart.** A new engine is used by every profile *launched* after the
   install (the resolver prefers the newest verified receipt); running
   profiles keep the engine they started with until they are restarted —
   the card says so. Nothing is killed behind the operator's back.

API: `GET /engine/update` (fresh check: `status`, `source`, `latest`,
`consent`, running `job`, and the `launchCheck`), `GET /engine/update/launch`
(the launch answer, no network), `POST /engine/update` (202 started / 200
already current / 403 no consent / 409 one already running / 403
cross-site).

### Not built here, deliberately (needs the hosted-deployment work order)

- **The server publish endpoint** (owner uploads a dist, server hosts the
  manifest + files) and **accounts/auth on it**. The client already reads
  any http(s) manifest whose entries carry absolute URLs + sha256, so a
  static file host works as a first server.
- **App self-update.** The app is still a source checkout run by `tsx`;
  there is no release artefact to download yet. The roadmap's compiled,
  single-executable client (track item 5) is that artefact. Once it exists
  the same client flow applies unchanged: manifest entry for the app (same
  schema, a new `kind`), download → sha256 → stage next to the running
  version → switch → restart via the start script. Recommendation for the
  interim: **release zips**, not `git pull` on team members' machines —
  git/npm on every machine, `reset --hard` destroying local state, and a
  broken `main` reaching everyone at once are the problems releases remove.

## C2 — Profiles that follow you (proposal, not implemented)

With the hosted track, the long-term answer is **"store on cloud" profiles
on the owner's server** (track item 3: the server is the source of truth,
the existing launch lease guards double-launch). Everything needed for the
data path already exists: encrypted bundles, server-side opaque storage,
revisions, leases.

The simplest flow **before** accounts exist — and for a solo operator with
two machines — is a **sync folder**:

1. Settings gets a sync folder (e.g. a OneDrive/Drive desktop folder).
2. When a profile stops, QueuePilot exports its encrypted bundle to
   `<sync folder>/<profile name>.qpbundle` (export needs the engine running,
   so it happens in the stop path just before the engine closes).
3. On the other machine the Profiles view offers "N profiles in your sync
   folder are newer — restore?" and calls the existing `/bundles/restore`.

Not implemented because: unattended export needs the bundle passphrase
stored per machine (DPAPI) — a security decision; bundles carry cookies
only (storage is "later" in `session-bundle.ts`); and two machines running
the same profile race without the server's revisions — the conflict rule is
the owner's call. If the hosted server is coming soon, skip the folder flow
and go straight to cloud profiles.

## Owner decisions

1. **Server exposure** — LAN-only or internet-reachable (TLS + domain).
   Determines the URL team members put in "Update server URL".
2. **How releases are published** — a static folder on the server
   (manifest + files, works with this client today) or an upload endpoint
   with owner auth (hosted work order).
3. **Engine hosting** — the 283 MB engine tarball must move from
   `file:///C:/queuepilot-engine/dist/` to the server; until then the
   manifest only resolves on the build machine.
4. **Auto vs manual install** — this branch: check automatically at launch,
   install on click with consent. Silent auto-install is one flag away but
   is a policy decision.
5. **Manifest auth** — public read, or a team token on the manifest/dist
   URLs (the client sends none today).
6. **App release artefact** — compiled single executable (track item 5)
   vs an interim release zip; bundled Node or "install Node 22 first".
7. **Code signing** — unsigned binaries trip SmartScreen/AV
   (`docs/av-notes.md`); certificate or documented exclusions.
8. **C2** — cloud profiles only (hosted track) vs an interim sync folder;
   whether a per-machine stored bundle passphrase is acceptable.
9. **Dashboard auth (roadmap B3b)** — needed before any code-running or
   install button can live in the dashboard of a token-protected install.
