# ADR-0005: Dashboard stack — vanilla JS now, React+Vite for the console track

Status: accepted (2026-11-09)

## Context

Roadmap P2 specified a React console; v0.8.0 shipped a zero-build vanilla-JS
dashboard instead (`apps/api/src/dashboard/`, ~500 lines total: 211 JS /
65 HTML / 229 CSS), served by the API itself at `/`. This ADR audits that
substitution against the two reference implementations and decides the stack
for the console's growth phase.

### What the references actually do (read from local clones, 2026-11-09)

**Fury** (`research/fury`, app code AGPL-3.0 — patterns only, never vendored):

- `desktop/` is Tauri 2 + React 19 + Vite 6 + TypeScript. The full operator
  console is a compiled React app: `ProfileTable`, `CommandPalette`,
  `Proxies`, `Cookies`, `Extensions`, `Trash`, `Audit`, `Settings`,
  i18n locales, theming — ~35 components under `desktop/src/components/`.
- HTTP is done by the Rust side, not the webview, so self-hosted servers can
  keep refusing all browser origins (no CORS surface).
- `site/` is plain static HTML — marketing only, no framework.

**AliasMode** (`research/aliasmode`, Apache-2.0 — reusable with attribution):

- Dashboard is React 19 + TSX (~30 modules under `web/`: app, store,
  proxies, scripts, i18n, theme) with **no bundler config at all**: Bun's
  HTML import (`import index from "./web/index.html"` in `web.ts`)
  transpiles and bundles TSX/CSS at serve time.
- Served by the same loopback process as the API; dashboard API lives in a
  separate `/ui/api/*` namespace so the AdsPower-compat surface is never
  touched; responses are redacted (metadata yes, secrets never); loopback-only
  bind by default; `no-store` cache headers.
- The Tauri desktop build reuses the same web UI.

Both projects — one AGPL/Rust, one Apache/Bun — independently converged on
**React + TypeScript for the operator console**, and both serve it from the
product's own process rather than a separate host.

### Why vanilla was still right for v0.8.0

- The shipped surface was a profiles grid, a proxy manager, and an SSE
  lifecycle feed. ~500 lines. A bundler, JSX toolchain, and dependency tree
  would have cost more than the feature.
- Hard constraints held: local-first, offline on loopback, zero build step,
  static assets committed in the repo, no separate hosting, bearer-token auth.
- The API contract (`@queuepilot/contracts` + SSE stream) is the real
  interface; the dashboard is a replaceable client of it.

### Why vanilla will not hold for the console track

The roadmap ahead is exactly the feature class both references built in React:

- Tab views with 7 sort modes, mass select, tab colors/notes (build-plan §3,
  adopted as "top notch").
- Command palette + keybinds (adopt early), menu editor, theme editor,
  format strings (later, but all UI-heavy).
- **Plugin-provided UI surfaces.** The Jancy lesson (build-plan §5.10) is
  that the registry ecosystem is the moat and cannot be retrofitted; plugins
  must eventually register web-interface endpoints and console panels.
  Hand-rolled DOM with no component model makes third-party UI contributions
  unsafe and unreviewable.
- i18n and a profile panel with per-field copy/refresh timestamps.

AliasMode proves "React" and "zero-build" are only compatible when the
runtime bundles for you (Bun HTML imports). QueuePilot runs on Node; our
equivalent is a compile step that outputs static assets — which preserves
every v0.8.0 constraint except "no build step in the repo", and that one is
the right thing to trade.

## Decision

1. **Keep the vanilla dashboard as-is through P3/P4** (automation depth, CDP
   attestation). No churn while the engine work lands.
2. **Migrate the console to React 19 + TypeScript + Vite in `apps/web/`** at
   the start of the console-depth track (tab views, palette). `vite build`
   emits static assets; `apps/api` serves them at `/` exactly as today —
   no separate hosting, loopback default, bearer token, offline, all kept.
3. Share types from `@queuepilot/contracts`; keep the dashboard API
   namespace separate from the AdsPower-compat surface (AliasMode pattern:
   compat contract is never touched by UI needs).
4. Redaction rule adopted verbatim as policy: the dashboard API exposes
   metadata (proxy host:port, cookie counts, drift state) and never secrets.
5. Component tests with vitest; the existing API contract tests stay the
   primary gate.

## Anti-goals

- **No Tauri / native shell yet.** Fury's desktop split is a distribution
  decision, not a console prerequisite; revisit when there is a demand for
  an installable desktop app.
- **No runtime JSX transform or CDN imports** (esm.sh et al.) — breaks the
  offline constraint.
- **No Bun migration** to get AliasMode's bundler-less React; the Vite build
  step is the honest Node equivalent.
- **No copying Fury app code** (AGPL-3.0). Patterns only. AliasMode code may
  be vendored with attribution under Apache-2.0 where useful.

## Consequences

- The repo gains a build step for the console only; the API stays
  zero-surprise (`tsc`). Contributors need `npm run build -w apps/web` before
  packaging; dev loop uses `vite dev` with the API on loopback.
- The vanilla `apps/api/src/dashboard/` is deleted once the React console
  reaches parity (profiles grid, proxy manager, SSE feed, token handling).
- Plugin-registered UI surfaces become feasible in a later phase without
  re-platforming.
