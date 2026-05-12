# Spec: Panic button - global emergency-stop for the active worker

**Created:** 2026-05-12 (brainstorm session "DevNeural Testing")
**Status:** Queued behind PROJECT-ANCHORS, ahead of SMART-COMPACT.
**TODO source:** TODO.md "Global panic button on the main dashboard" entry.

---

## Goal

One-click emergency stop for a runaway worker session. Button lives in the dashboard top bar next to the existing listen / mute / stop controls. Click sends a double-ESC keystroke (`\x1b\x1b`) to the active worker terminal, which is the Claude Code interrupt sequence. Same effect as the user pressing ESC twice at the worker keyboard, no matter where they are in the dashboard.

---

## Why a button (not just keybind)

- Hands-busy use case. User is talking to Lex, sees runaway tool loop on a tile, wants to halt without keyboard focus on the worker window.
- Mobile / remote dashboard. Tailscale-served dashboard from a phone can't send ESC keys directly to a desktop process.
- Single chokepoint. One control everyone learns; muscle memory next to the existing stop button.

---

## UI

- Location: dashboard top bar, immediately to the right of the existing stop control. Same group as listen / mute / stop so it reads as part of the voice/control cluster but visually distinct (red fill, alert icon).
- Label: `Panic` or icon-only with `aria-label="Emergency stop active worker"`. Tooltip: `Send double-ESC to active worker (interrupt current tool / generation)`.
- States:
  - `idle`: red outline, ready to fire.
  - `firing`: solid red, 250ms pulse, disabled.
  - `cooldown`: 1s lockout after fire to prevent double-tap.
- No confirmation dialog. Confirmation defeats the purpose. Cooldown handles fat-finger.

---

## Targeting: which session is "active"

Single-target rule for the global button:

1. If exactly one project anchor has `status='live'`, target it.
2. If multiple live anchors, target the one whose worker `phase` is `thinking` or `tool` (the runaway is almost certainly the busy one).
3. If still tied, target the most recently active by `last_activity_ms`.
4. If no live anchors, button is disabled with tooltip `No live worker to interrupt`.

Resolution happens at click time, not on render, so the targeting logic uses fresh state.

Per-tile mini-panic buttons are deferred. Add only if usage shows the global button targets the wrong session often.

---

## Transport: PTY raw inject

Reuse the existing PTY inject path with two additions:

1. New optional flag on `POST /pty/:id/inject`: `raw: true` and `commit: false`. With `raw`, the body bytes go to the PTY without trailing newline / commit semantics. With `commit:false`, no audit-trail injection-log entry is required (or use a separate event type, see audit below).
2. Alternative: dedicated endpoint `POST /pty/:id/interrupt` that hardcodes `\x1b\x1b` as payload. Cleaner surface area, no flag combinatorics. Preferred.

For project-anchor-targeted panic (post PROJECT-ANCHORS landing), endpoint becomes `POST /projects/:id/interrupt` and resolves anchor -> current_pty_id internally.

---

## Audit

Every panic fire writes a row to `panic_log` (or extends `cross_session_injection_log`):

| column | type | notes |
|---|---|---|
| `id` | TEXT PK | UUID |
| `target_anchor_id` | TEXT | resolved at click |
| `target_pty_id` | TEXT | resolved at click |
| `target_session_id` | TEXT | CC session UUID at click |
| `clicked_ms` | INTEGER | client-reported, server-validated |
| `caller` | TEXT | dashboard / lex-tool / streamdeck |
| `result` | TEXT | accepted / pty_not_found / no_target |

Dashboard panel surfaces last 20 panics with timestamp and target so the user can audit interrupts.

---

## Lex tool surface

Expose as a Lex tool: `panic(target?: anchor_id)`. Default target uses the same single-target rule as the button. Lex calls it on user voice command (`emergency stop`, `kill the worker`, `panic`). Same `/projects/:id/interrupt` endpoint under the hood.

---

## Keybinding

Global keyboard shortcut on the dashboard: `Ctrl+Alt+.` (period). Period is the universal stop key in many terminals; Ctrl+Alt prefix avoids conflict with text input. Listed in the tooltip so users discover it.

OS-level global shortcut (works without dashboard focus) is deferred. The dashboard focused shortcut covers the primary use case; OS-level requires the Stream Deck tray app or a separate global hook.

---

## Already done - do NOT redo

- PTY inject pipeline exists (`POST /pty/:id/inject` plus the bridge transport).
- Cross-session inject HMAC + audit pattern shipped commit `8f68121`. Reuse the audit-row shape.
- Top bar exists in dashboard layout with listen / mute / stop. Drop the new button into the same row.

---

## Migration plan

1. Add `POST /projects/:id/interrupt` endpoint (or `/pty/:id/interrupt` if PROJECT-ANCHORS step 3 hasn't shipped yet, then rename in step 5 of anchors).
2. Implement single-target resolver in `07-daemon/src/dashboard/panic-target.ts`.
3. Add `panic_log` migration (020) or extend cross-session log table.
4. Dashboard top-bar panic button component, wires to endpoint.
5. Dashboard keybinding handler (Ctrl+Alt+.).
6. Lex tool registration (`panic(target?)`).
7. Dashboard audit panel showing last 20 panics.

---

## Constraints / decisions

- Global button only at v1. Per-tile mini-panic deferred.
- No confirmation dialog. 1s cooldown only.
- Reuse existing PTY inject; do not invent a new transport.
- Single-target resolver runs at click, not at render.
- OS-level global shortcut deferred.
- Audit is non-negotiable; every fire logged.
