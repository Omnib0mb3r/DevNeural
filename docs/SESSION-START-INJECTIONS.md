# SessionStart Injections

Registry of every payload that gets injected into a fresh Claude Code session at SessionStart via `additionalContext` (stdout from a hook).

Add a row whenever a new SessionStart hook starts writing to stdout.

| Name | Purpose | Hook entry point | Toggle | Notes |
| --- | --- | --- | --- | --- |
| `caveman-activate` | Activates caveman mode banner + level (lite/full/ultra). Compresses output ~75%. | `silent-shim.exe node C:/Users/michael/.claude/hooks/caveman-activate.js` (settings.json SessionStart) | `~/.claude/caveman-mode.json` (off/lite/full/ultra) | Always-on across all CC sessions; per-mode level cached on disk. |
| `cold-start-preload` | Sibling-session decision block for fresh Lex brainstorm sessions: index of prior siblings + last 5-10 turns of the most recent two, plus (2026-09-22) the rich context pack: the supervised worker's git state and commits, its latest handovers in full, Lex's own last handover, the plan's task state, the worker's recent turn summaries, open BUGS.md rows. Scoped to the one supervised worker. | `silent-shim.exe node C:/dev/Projects/DevNeural/07-daemon/dist/capture/hooks/hook-runner.js session_start` (settings.json SessionStart) → `postColdStartPreload` → daemon `POST /lex/cold-start-preload` (pack from `src/lex/lex-context-pack.ts`) | `runtime_config.lex_cold_start_preload_enabled` (off/shadow/live), default shadow; dashboard panel + `/lex/cold-start-preload/toggle` endpoint | Only fires for `source=startup`; no-op for resume/clear/compact. Audited via `cross_session_log` rows with `caller_label='cold-start-preload'`. |
| `worker-clear-handoff` | The fresh worker session's boot block after a `/clear`: an approved Phase C handover (worker draft + Lex review, served exactly once) or the legacy recomputed handoff (git state, active task, next-up queue, blockers). | `hook-runner.js session_start` (every source) → `postWorkerHandoff` → daemon `POST /worker/clear-handoff { session_id, cwd }` | `DEVNEURAL_WORKER_HANDOFF_ENABLED` (env; off/false/0 disables) | Empty block for any cwd that is not a project anchor. The approved-handover path is `HandoverApprovalRegistry.consumeApproved` (`src/dashboard/routes.ts`), logged `[handover] clear-handoff served approved handover`. |
| `lex-clear-handoff` | The fresh Lex session's boot block after her own `/clear` (AUTO-CLEAR T4): her approved handover (Lex draft + judge review) plus the context pack, served exactly once, then a kick prompt from the daemon six seconds later so the session's first turn carries it. | `hook-runner.js session_start` (`source=clear` or `compact`) → `postLexClearHandoff` → daemon `POST /lex/clear-handoff { session_id, cwd }` | none beyond `auto_clear_mode` (the daemon only types `/clear` for her in live mode); the route answers empty unless a self-clear is pending | Brainstorm cwd only (`<DATA_ROOT>/brainstorm`). Pending reseeds expire after 30 minutes. Logged `[self-clear] clear-handoff served`. See `docs/spec/SMART-COMPACT.md` section 5 item 5. |

## Adding a new injection

1. Hook must be wrapped in `silent-shim.exe` so stdin (CC payload) and stdout (injected block) flow correctly. Bare `wscript`/`cmd` paths drop one or both.
2. Hook should write the block to `process.stdout` followed by a newline. CC reads stdout and treats it as `additionalContext` on the first user turn.
3. Wrap the call in a feature toggle (env or `runtime_config`) so it can be killed without restarting CC.
4. Add a row to the table above with the toggle key and any audit-log location.
5. Keep block size bounded; combined SessionStart stdout across all hooks shows up as a prepended context block on every first turn.
