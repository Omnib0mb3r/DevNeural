# Leftover Session Ghost Tiles

**Status:** Closed
**Reported:** 2026-05-04
**Last seen:** 2026-05-05 09:30 ET
**Closed:** 2026-05-11 (Wave 3 fixup sprint, soak window passed; no recurrences logged in 6 days of active use)
**Affected surfaces:** Virtual deck (08-dashboard), Physical Stream Deck (stream-deck repo)

## Symptoms

1. After running `/clear` or `/compact` in Claude Code, a phantom tile lingers on both decks for the previously-active session for up to 10 minutes.
2. Virtual deck hides any session whose jsonl mtime ages past 10 minutes, so a session that goes quiet during real work disappears from the rail.
3. Physical deck keeps the slot but the tile is "dead" on press: tap focuses nothing, no log line, no visible reaction.
4. After every prompt, tiles flicker out and re-register repeatedly. State seems good for a moment, then the tile vanishes, then comes back on next state-hook fire.
5. State files left over from manual testing (`t.json`, `test.json`) auto-register on app boot and paint extra phantom tiles.

## Root Causes

There are five distinct causes layered on top of each other. Each one was contributing to a different symptom.

### 1. `/clear` does not delete the prior jsonl

Claude Code allocates a new `session_id` and a new `~/.claude/projects/<slug>/<id>.jsonl` on `/clear` and `/compact`. The old jsonl stays on disk with its mtime touched at the moment of the clear. The DevNeural daemon's `listSessions()` reads the directory and treats anything with a recent mtime as `active: true`, so the old session keeps showing up alongside the new one.

### 2. Virtual deck hides idle sessions

`08-dashboard/components/StreamDeck.tsx` defaults `showStale = false`, filtering the rail to only those sessions with `active: true` (mtime within 10 minutes). A session that goes quiet falls off the rail entirely.

### 3. Physical deck has no continuous liveness sweep

`StreamDeck.App` validates registry contents once at startup (`ValidateRehydratedSessions`) but never again. Sessions whose VS Code window or shell died ungracefully sit in the registry forever, holding a slot, painting a tile that does nothing on press.

### 4. State-hook auto-registration ignores liveness

`OnStateReceived` auto-registers any state-hook update for an unknown session. Old test fixtures (`t.json`, `test.json`) and stale state files from prior runs paint phantom tiles on every app start, then get dropped 60 seconds later by the sweep — visible flicker.

### 5. Hook-bash pid is ephemeral on Windows

On Windows, every Claude Code hook fires through `wscript.exe → node → hook-runner.js` (or in stream-deck's case, a direct bash invocation per hook). Each fire is a brand-new bash with a new winpid that exits within milliseconds. The ShellPid recorded in the identity / state files is therefore dead almost immediately. A liveness sweep that drops on dead-pid alone clears every legitimate session on every tick, which is the drop+register flicker users were seeing.

## Fixes Shipped

| Repo | Commit | Purpose |
|---|---|---|
| DevNeural | `50e0c6c` | SessionStart hook + cwd-encoded slug + 5s proximity gate; superseded store filtered out of `listSessions` |
| DevNeural | `8ccfca2` | Lex personality library + easter egg + empty-state pass (unrelated, same wave) |
| DevNeural | `587e290` | Forward "※ recap:" lines from user shell to dashboard activity rail |
| DevNeural | `73c1c99` | Forward Lex's last assistant turn to dashboard on Stop |
| DevNeural | `61ebac4` | Default `showStale = true` on the virtual deck rail |
| stream-deck | `0df2095` | Purge stale identity records when shell starts new session |
| stream-deck | `2bc04c4` | Periodic liveness sweep + tap-time recovery for dead-host slots |
| stream-deck | `97aff48` | Liveness gate before auto-registering from state files |
| stream-deck | `3e87007` | 120s state-file freshness grace window (superseded by 46234df) |
| stream-deck | `46234df` | Replace pid-liveness gate with timestamp-fresh + window-match — pid is always dead because the hook-bash exits in ms |

## Verification

- Daemon route `/sessions/clear-supersede` smoke-tested with a synthetic session id; returns `{"ok":true,"superseded":<prior id or null>}`.
- Daemon route `/sessions/:id/lex-pulse` smoke-tested against a session with a recent text turn; emitted notification with body, link, severity.
- Physical deck rebuilt cleanly (`dotnet build`, 0 warnings, 0 errors). Live app pid 24840 (as of fix). Registry currently shows one entry matching the live shell after a soak prompt.
- Virtual deck typecheck (`tsc --noEmit`) clean.

## Open Items

Long soak (24 h) requirement satisfied as of 2026-05-11; no recurrence of
the flicker or phantom-tile symptoms across 6 days of active use. Bug
closed in the Wave 3 fixup sprint.

Residual follow-ups (not blockers; tracked for future polish, not in any
specific wave scope):

- The hook-bash pid problem deserves a real fix: capture a more stable identifier (CC TUI process, VS Code workspace process) instead of the ephemeral hook bash. Current workaround relies on the state-file freshness window.
- Consider exposing a manual "purge dead tiles" button on the virtual deck and an REPL command on the physical deck for when the heuristics fail.
- Test fixture state files (`t.json`, `test.json`) should be added to a `.streamdeckignore` or similar so they never auto-register; currently filtered only by liveness.
