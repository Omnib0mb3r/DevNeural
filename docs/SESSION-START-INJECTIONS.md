# SessionStart Injections

Registry of every payload that gets injected into a fresh Claude Code session at SessionStart via `additionalContext` (stdout from a hook).

Add a row whenever a new SessionStart hook starts writing to stdout.

| Name | Purpose | Hook entry point | Toggle | Notes |
| --- | --- | --- | --- | --- |
| `caveman-activate` | Activates caveman mode banner + level (lite/full/ultra). Compresses output ~75%. | `silent-shim.exe node C:/Users/michael/.claude/hooks/caveman-activate.js` (settings.json SessionStart) | `~/.claude/caveman-mode.json` (off/lite/full/ultra) | Always-on across all CC sessions; per-mode level cached on disk. |
| `cold-start-preload` | Sibling-session decision block for fresh Lex brainstorm sessions: index of prior siblings + last 5-10 turns of the most recent two. Lets Lex resume context without `Read` calls. | `silent-shim.exe node C:/dev/Projects/DevNeural/07-daemon/dist/capture/hooks/hook-runner.js session_start` (settings.json SessionStart) → `postColdStartPreload` → daemon `POST /lex/cold-start-preload` | `runtime_config.lex_cold_start_preload_enabled` (off/shadow/live), default shadow; dashboard panel + `/lex/cold-start-preload/toggle` endpoint | Only fires for `source=startup`; no-op for resume/clear/compact. Audited via `cross_session_log` rows with `caller_label='cold-start-preload'`. |

## Adding a new injection

1. Hook must be wrapped in `silent-shim.exe` so stdin (CC payload) and stdout (injected block) flow correctly. Bare `wscript`/`cmd` paths drop one or both.
2. Hook should write the block to `process.stdout` followed by a newline. CC reads stdout and treats it as `additionalContext` on the first user turn.
3. Wrap the call in a feature toggle (env or `runtime_config`) so it can be killed without restarting CC.
4. Add a row to the table above with the toggle key and any audit-log location.
5. Keep block size bounded; combined SessionStart stdout across all hooks shows up as a prepended context block on every first turn.
