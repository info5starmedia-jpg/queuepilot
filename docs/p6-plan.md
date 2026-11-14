# P6 — Product Layer (draft, 2026-11-13)

Preconditions: P5 done — official engine published, auto-update works,
installer exists. P6 turns the engine into the daily driver: Jancy's
workflow ideas (public docs only — ideas are free, no code) on top of our
engine + AliasMode-style lifecycle discipline.

## P6.1 — Bulk profiles: CSV / Sheets import

The single biggest workflow multiplier: 50 profiles from a spreadsheet
instead of 50 clicks.

- [ ] CSV import: `profiles.csv` columns = name, proxy (host:port:user:pass
      or provider URL), timezone, locale, platform, group/tags, notes.
      Dry-run preview with per-row validation errors before anything is
      written.
- [ ] Google Sheets source: read-only via share link (no OAuth for v1 —
      publish-to-web CSV export URL), re-import = upsert by name.
- [ ] Export back to CSV (round-trip fidelity test).
- [ ] Persona derivation stays automatic: identity seed per profile row,
      noise seeds derived (never imported), screen/timezone/locale coherent
      with the proxy's geo (see P6.2).

## P6.2 — Proxy providers & geo coherence

- [ ] Provider registry: named providers (e.g. "home-5g", "datacenter-us")
      with URL templates and per-profile credential slots; rotation policy
      (sticky / per-launch / per-N-minutes).
- [ ] Geo coherence check: proxy exit geo → timezone/locale suggestion at
      import time; warn (don't block) on mismatch. A US exit with
      Asia/Shanghai is the classic self-own.
- [ ] Resolver: per-profile DNS through the proxy (already engine-side via
      relay; expose the toggle in profile settings).
- [ ] Health: background check marks proxies dead/alive with last-seen;
      dead proxy = profile won't launch unless overridden (never silently
      fall back to the host connection — that's a leak).

## P6.3 — Tab & session ops

- [ ] Session bundles v2: export/import a profile's full state (cookies —
      carried by the 0110 travel key — storage, tabs) as one file for
      moving between machines (the family use case).
- [ ] Tab sets per profile: named startup URL lists ("open these 6 on
      launch").
- [ ] Mass ops: launch/stop a whole group, stagger launches (jitter 5–30 s)
      to avoid thundering-herd patterns.

## P6.4 — Scripting API

- [ ] `queuepilot profile launch <name> [--headless-detached]`,
      `queuepilot profiles list --json`, `queuepilot engine update` —
      scriptable CLI over the existing API (exit codes + JSON, no scraping).
- [ ] Local REST surface stays localhost-only with a per-install token;
      document it so power users can drive profiles from their own tools.
- [ ] Webhook-free automation examples in docs (start all, rotate proxies,
      export health CSV).

## P6.5 — Console UX (vanilla, incremental — no framework migration)

- [ ] Group view: launch/stop buttons per group, health badges.
- [ ] Profile duplication (clone persona + proxy slot, new seed).
- [ ] Search/filter by tag, proxy, last-used.
- [ ] "Verify this profile" button: runs the quick claim subset against
      that profile's actual proxy and shows the result inline.

## P6.6 — Quality bars (standing, every P6 merge)

- Gates stay: typecheck 0 errors, 188+ tests green, build clean, claim
  suite green on the current engine.
- Every new feature touching the network path gets a leak test in
  `apps/api/verify/` (the claim suite grows; it never shrinks).
- Docs updated in the same commit as the feature.

## Explicit non-goals for P6

- No cloud sync, no accounts, no telemetry — local-first forever.
- No mobile shells.
- No fingerprint-surface additions unless a detection vector is proven
  against us (then it's an engine patch with a verify script, not a P6
  feature).
