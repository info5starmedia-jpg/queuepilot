# UI design — QueuePilot console

Decisions from the 2026-11-15 workspace/UI brainstorm (owner-approved: "A1,
Jancy classic style"). This doc is the reference for anyone touching the
console or planning UI work.

## Direction: Jancy classic

Dark, dense, table-first, left-spine feel — the same direction Multilogin,
GoLogin, AdsPower and Jancy all converge on for a multi-profile daily driver.
Key points:

- **The shipped console already IS this style.** `apps/api/src/dashboard/
  styles.css` is fully CSS-variable-driven: `--bg: #0d1117`,
  `--panel: #161b22`, accent `--accent: #58a6ff`. "Theme: jancy" = the current
  look, unchanged.
- **Rejected alternatives:** big card grid (Option B — too sparse for
  hundreds of profiles) and card-first hybrid (Option C). Profile cards stay
  only as the per-profile action surface.
- **Future navigation:** folder/group tabs above the profiles table (the
  GoLogin pattern). Not built yet — track as its own task before adding more
  sections.
- **Light theme:** schema-only for now (`general.theme: "jancy" | "light"` in
  `packages/contracts/src/settings.ts`). Persisting the choice works end to
  end; the light CSS variable override is deliberately unbuilt until asked.

## Settings section (v0.14.13, A1)

The console's sixth section (after Setup checklist, Profiles, Import CSV,
Proxies, Tabs, Events — Settings now follows Events). Subsection nav across
the six contract sections; every control PATCHes
`/settings/sections/:section` immediately on change; failed saves revert the
form and post to the event stream.

## Windows model: separate windows per profile (Plan A) — locked

Each launched profile opens its own browser window; the console is the
single control surface. This matches Multilogin / GoLogin / Jancy / AdsPower.
The brainstorm's Plan B (one GoLogin-style workspace window with profile
tabs) and any headless mode are **out of scope** — owner ruled both out on
2026-11-15. Revisit only if the owner reopens the question; the tab-ops layer
(`tab-thinger`) already has the primitives a workspace window would need.

## Next UI items (from the brainstorm, in order)

1. ✅ A1 — Settings store + console Settings section (v0.14.13).
2. ✅ A2 — Batch-start controller: profile checkboxes + sticky action bar +
   `POST /profiles/batch-start {ids, staggerMs}`; the stagger delay comes
   from Settings → Launch, so A1+A2 compose (v0.14.14).
3. ✅ A3 — Window tiling: cascade/grid presets over running windows
   (`POST /profiles/batch-tile`), single-window bounds, and restore of the
   per-profile geometry remembered in the persona layer (v0.14.15).
