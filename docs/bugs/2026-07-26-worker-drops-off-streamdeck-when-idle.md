# Bridge worker drops off the Stream Deck when idle (identity-freshness liveness ignores the live anchor)

**Status:** fix committed (see commit in index row) — pending daemon rebuild + restart + live verify
**Date:** 2026-07-26
**Severity:** high (a running, bound worker becomes invisible + re-listed as "ready to start")

## Symptoms the user actually saw

- Started a worker (dropship-01) from the dashboard. It ran and was bound to its brainstorm.
- On **VS Code window reload** (and any time the worker went quiet), the worker **vanished from the Stream Deck** and got re-offered as an idle "Start Claude" tile, as if it were not running.
- User's expectation: a worker must re-attach to its correct brainstorm on every start / reload / restart / close-reopen, and stay visible while it is alive. User believed this "never really worked properly."

## What is NOT broken (verified)

The anchor binding is correct. Read straight from the DB during the incident: `project_session` row for dropship-01 was `status='live'`, `current_session_id=c79dfeb9…`, `current_bridge_id` set, `last_seen_ms` fresh, and brainstorm `0d5c1ca8` was supervising it. The bridge-presence reconcile (`bridge-presence.ts`) re-binds the anchor correctly on reconnect. **The linking layer works.**

## Root cause

The **live-session display surface** re-derives its own liveness instead of trusting the authoritative anchor:

- `listSessions()` (`07-daemon/src/dashboard/sessions.ts`) only emits a session whose StreamDeck identity file is fresh (`readLiveSessionIds()`), and drops any other jsonl entirely. A bridge-hosted worker (VS Code terminal) stops touching that identity file the moment it goes idle — e.g. right after a reload — so it is dropped and disappears from both the physical and virtual Stream Deck.
- The `GET /sessions` idle-filter (`routes.ts`) additionally only counts a session "live" when it is **daemon-owned** (has a daemon PTY). A bridge worker is never daemon-owned, so even a fresh one is classified as an idle "ready to start" project.

So a bridge worker only appeared live while it was actively writing its transcript. Idle (reload, or just finished a task) → gone. The authoritative `project_session.status='live'` (bridge-backed, reconcile-maintained) was never consulted by these surfaces.

## Fix (surgical, single authoritative signal)

New shared helper `liveAnchorSessionIds(db?)` in `sessions.ts` returns the bound `current_session_id`s of all `status='live'` project anchors (the reconcile flips them dormant the instant the bridge connection drops, so it is already bridge-gated). Two consumers now trust it:

1. `listSessions()` retains a session when its identity file is fresh **OR** its anchor is live → an idle-but-bound bridge worker stays on the deck.
2. `GET /sessions` marks a project live (not an idle tile) when it has an active session that is daemon-owned **OR** anchor-live → no more double-listing a running bridge worker as idle.

No new machinery, reuses the existing `listProjectSessions({status:'live'})` accessor. Test: `tests/live-anchor-session-ids.test.ts` (3 cases, passing). Daemon compiles clean.

## Explicitly OUT of scope (do not conflate)

- **Do NOT convert the worker to a daemon-PTY.** The worker mirror is a *separate* problem (see the mirror bug doc). The worker terminal must stay ported from the VS Code / Claude Code terminal via the bridge.
- **Do NOT touch how Lex's own mirror/session works.**

## Open items

- [ ] Rebuild + restart daemon to activate (session-recycling, user-timed).
- [ ] Live verify: reload the dropship-01 VS Code window; the worker must stay on the Stream Deck and stay bound to brainstorm 0d5c1ca8.
- [ ] Consider whether other surfaces (Workers panel, supervision) also key off identity-freshness rather than the anchor; they appeared to read the anchor already, confirm on verify.
