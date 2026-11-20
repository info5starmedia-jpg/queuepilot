# ADR-0008: Profile Deck, one window with a tab per running profile

**Status:** accepted and built (2026-11-20) after the spike below passed. Owner GO 2026-11-19.

## Context

The owner runs 10–20 profiles at once. Today every profile is its own engine
process with its own top-level window and taskbar button, which is cluttered.

The owner's ask (round-1 Q1, 2026-11-19):

> "It shouldn't be its own browser, but it should be its own tab… new tabs
> open instead of new windows… one nice container like a window."

They also require that **a profile is kept until they delete it** and that
**each profile keeps its own locked IP**.

## Why not real tabs in one Chromium

Each profile's fingerprint (Fury BSD patches: screen, GPU, fonts, …),
proxy relay and data dir are bound **per engine process**
(`--user-data-dir`, the persona handle).

Putting many identities into one Chromium process would mean:

- **an engine rewrite**: a per-BrowserContext persona across ~30 patches;
- **weaker isolation**: shared GPU and network process, and timing
  side-channels between identities. This breaks the handoff mission ("profiles
  indistinguishable from real stock-Chrome users").

**Rejected.**

## Decision (proposed)

Add a **Profile Deck**: one QueuePilot container window whose **tab strip has
one tab per running profile**.

- Each engine keeps running as its own process with its own fingerprint and
  IP. Nothing changes at the engine or network level.
- **The Deck adopts each engine's top-level window** as a child of the
  container (Win32 `SetParent`, owner/style fix-up) and removes its taskbar
  button (`ITaskbarList::DeleteTab`). Clicking a tab shows that profile's
  window; the others are hidden, not minimised.
- **Tab label = a format string.** The default is `email · queue position`
  (owner Q13: show email/name and queue position; codes stay in the
  background). It is driven by the tab-state / extractor data (J3/J6).
- **Popups and new windows** a profile opens are adopted under that
  profile's tab (sub-tabs, or a per-profile strip).
- **Opt-in per launch** (`deck: true`, plus a settings default). Without it,
  windows behave exactly as today.

## Fingerprint guard (why this needs a spike first)

Reparenting changes what the page can observe:

- `window.screenX/Y`
- `outerWidth − innerWidth` (chrome deltas)
- `screen.availLeft/Top`
- focus and visibility (`document.hasFocus`, Page Visibility when hidden)

The window-fit invariant ("no window exceeds the profile's claimed screen")
must hold inside the container, too.

**The spike** adopts one fury profile into a container and runs the claim
suite + attestation:

- **pass** → build;
- **fail on a vector** → fix it in the Deck (offsets, never hide) or drop
  the Deck.

Hidden tabs also need focus emulation (CDP `Emulation.setFocusEmulationEnabled`).
Otherwise background tabs hit "Browsing Activity Paused", which is exactly
Jancy's Focus Delay problem.

## Options for the container process

1. **Electron/WebView2 shell app** (`apps/deck`). Tab strip in HTML.
   Win32 calls through a prebuilt FFI (`koffi`). Simplest UI.
2. **A small native helper**, driven by the API. AV-sensitive on this
   machine (the v0.13 AV kills), so this is less attractive.
3. **Taskbar grouping only.** One shared AppUserModelID on all engine
   windows. Cheap, partial (one taskbar icon, still separate windows).

**Plan:**

- ship **3 first** as a quick win;
- spike **1**;
- decide after the claim suite.

## Consequences

- No engine changes. Fingerprint isolation unchanged (verified by the spike).
- The Deck is Windows-only at first (owner's platform). macOS/Linux keep
  separate windows.
- Tab-state, format-string and queue-position work (J3/J6/J7) gets a real
  tab strip to render into. This replaces the "engine tab titles need an
  engine patch" 🖥 item in the parity report.

## Spike result (2026-11-20) and what was built

Option 1/2 were replaced by a **PowerShell + WinForms host** (`deck-host-script.ts`): plain user32 `SetParent`, no Electron, no koffi, no native binary.

Fury 0.5.5-qp.4 profiles, probed over CDP before and after adoption:

| Vector | Free window | Adopted (WS_CHILD, frame kept) |
|---|---|---|
| `outerWidth − innerWidth` / height | 16 / 95 | **16 / 95** |
| `screen.availLeft/Top/Width/Height`, `screen.width/height` | persona's | unchanged |
| `screenX/Y` | window position | container-relative position (plausible) |
| `document.hasFocus()`, `visibilityState` of a hidden tab | true / visible | true / visible (no "Browsing Activity Paused") |

- **Finding 1:** stripping the frame (the obvious way) changed the deltas to 14 / 94. Keeping `WS_OVERLAPPEDWINDOW` and only swapping `WS_POPUP` for `WS_CHILD` keeps 16 / 95. The invisible resize border is offset outside the container, never hidden.
- **Finding 2:** the window-fit watcher shrank an adopted window that exceeded its profile's claimed screen (1536x864 persona), so the container is capped at 1280x714 client and cannot be maximised.
- **Not covered:** the full Python claim suite was NOT run inside a container (it launches its own browser); 125 %+ DPI scaling, multi-monitor, and popups/new windows opened by a profile (they stay separate top-level windows for now).
