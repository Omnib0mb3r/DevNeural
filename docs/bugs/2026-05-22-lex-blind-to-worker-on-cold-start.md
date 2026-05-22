# 2026-05-22 Lex cannot see worker on cold start

**Status:** open

## Symptom

New Lex brainstorm session begins with project bound via `supervises_project_anchor_id`. `live_state` reports the project anchor live with a `current_session_id`, yet Lex's first inject silently fails to land in the worker prompt. User has to babysit, confirm injects never landed, repeat manually.

## What we know

- `POST /lex/inject-cross-session` returns `{ok:true, decision:accepted, transport:bridge}` even when delivery fails.
- Bridge presence file exists and is fresh.
- Worker jsonl shows no new user turn after the inject.
- Lex did not vet the worker state before declaring "injected."

## Action

Diagnose why the existing cold-start preload + anchor resolution path does not produce a delivery-capable handle by session-second-0. Fix the gap between "anchor flagged live" and "Lex can actually reach this worker."

Acceptance: cold-start inject lands within 5s, or daemon returns a structured `delivery-failed` so Lex can react instead of bluffing.

## Root cause (diagnosis, 2026-05-22)

The presence -> anchor -> inject chain is structurally honest about *liveness* but blind to *deliverability* for any worker the daemon did not spawn itself.

1. `reconcileBridgePresence` (`07-daemon/src/dashboard/bridge-presence.ts`) flips a `project_session` row to `status='live'` and stamps `current_session_id` whenever a fresh bridge presence file claims a `cc_session_id` for that cwd. It never stamps `current_pty_id` for externally-launched (VS Code-typed) workers; that column is reserved for daemon-owned PTYs.
2. `POST /lex/inject-cross-session` -> `crossSessionInject` (`07-daemon/src/lex/cross-session-inject.ts:251-323`) tries the daemon-owned PTY path first (`listPtysFn().find(...)` at :255-258). For a VS-Code-typed worker that list is empty, so it falls through to the bridge fallback at :286-292 and calls `queueSessionPromptFn(target_session, text)`.
3. The fallback's `accepted` verdict at :305 and the `{ok:true, decision:'accepted', transport:'bridge'}` return at :323 are keyed solely on `queueSessionPromptFn` returning `ok:true`. `queueSessionPrompt` (`07-daemon/src/dashboard/sessions.ts`) only checks bridge heartbeat freshness and file-append success; it does NOT verify that any bridge instance actually has a deliverable terminal for that `cc_session_id`.
4. The cold-start preload path (`07-daemon/src/lex/lex-cold-start-preamble.ts`) assembles sibling context for `<live_state>` but has no deliverability probe and no warm-up inject before Lex's first user-driven inject lands.

Net: on a fresh brainstorm against an externally-launched worker, the anchor is correctly flagged live, the inject endpoint correctly takes the bridge fallback, the queue file is correctly written, and the response correctly says "accepted" by its own definition. The lie is the contract: "accepted" is being reported as "delivered." Until the inject endpoint either (a) confirms a bridge owns a real terminal for the UUID before declaring acceptance, or (b) returns a structured `delivery-failed` when no such bridge exists, Lex has no signal to react to. This bug is the same root failure as `2026-05-22-worker-discovery-both-launch-paths.md` viewed from the cold-start angle: presence claims a UUID, no bridge actually carries it.

## Resolution (2026-05-22, absorbed by worker-discovery fix)

Closed via the same change set that lands the worker-discovery fix:

- Bridge presence payload now carries `has_terminal_for_uuid`
  (presence.ts:26-50). Bridge fills it from a sync probe over
  `vscode.window.terminals` cross-referenced with the existing
  `claudeTerminalCache` (extension.ts `hasClaudeTerminalInThisWindow`).
- Daemon resolver
  `resolveDeliverableBridgeForSession(ccSessionId)` in
  `07-daemon/src/dashboard/bridge-presence.ts` returns one of
  `deliverable` / `legacy-grace` / `no_terminal` / `not_claimed`.
- `crossSessionInject` (`07-daemon/src/lex/cross-session-inject.ts`)
  consults the resolver before falling through to
  `queueSessionPrompt`. Verdicts `no_terminal` and `not_claimed`
  short-circuit with a new audit row decision
  `no_deliverable_bridge` (widened by migration 032) and the route
  surfaces `{ok:false, decision:'no_deliverable_bridge',
  deliverability_verdict:...}` so Lex sees the real failure
  instead of a bluffed `accepted`.
- Migration grace: presence files that omit
  `has_terminal_for_uuid` (older bridges) resolve to
  `legacy-grace`, which is treated as deliverable for one tick so
  the rollout window does not break existing fleets.

No separate cold-start probe was added. The acceptance condition
"daemon returns a structured `delivery-failed` so Lex can react
instead of bluffing" is now met directly by Lex's first real
inject; an extra probe would either be a true no-op (redundant) or
visibly inject probe text into the worker input box, which is not
acceptable. Lex's existing system prompt already treats
`decision !== 'accepted'` as a signal to re-vet state.
