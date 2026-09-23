# Bug investigation docs

The tracker of record is the repo-root [BUGS.md](../../BUGS.md): read its
index block first, then the one detail block you need. This folder holds
the longer per-bug investigation write-ups for bugs that are still open.
When a bug reaches RESOLVED in BUGS.md, its write-up moves to
[docs/archive/bugs/](../archive/bugs/) in the same commit.

## Open investigations

| Date | Bug | Status | Severity |
|------|-----|--------|----------|
| 2026-07-26 | [Bridge worker drops off the Stream Deck when idle (liveness ignores the live anchor)](./2026-07-26-worker-drops-off-streamdeck-when-idle.md) | fix committed (`liveAnchorSessionIds` shared helper); live verify pending; see BUGS.md BUG-001 / BUG-011 | high |
| 2026-07-26 | [Sessions assert deploy/"fixed-in-prod" state from stale docs instead of live state](./2026-07-26-sessions-assert-deploy-state-from-stale-docs.md) | open; the 2026-09-22 L2 rule "current state first" and the context pack address the Lex side | medium |
| 2026-07-26 | [Worker terminal mirror blank (VS Code removed the `terminalDataWriteEvent` proposed API)](./2026-07-26-worker-mirror-blank-bridge-terminal-data.md) | migrated to the shell-integration API; operator reload + verify pending; BUGS.md BUG-007 DEFERRED | medium |
| 2026-07-26 | [Start Claude one-click spawn stalls at the first-run "trust this folder" prompt](./2026-07-26-start-claude-blocked-by-trust-prompt.md) | fix committed (`72b332b`); the same seed now guards the Layer 1 cwd (BUG-031 RESOLVED) | medium |
| 2026-05-29 | [Voice PTY paste lands as `[Pasted text #N +5 lines]`, never submits](./2026-05-29-voice-pty-paste-no-commit-regression.md) | investigation shipped; ship deferred (mirror the Fix 32 850ms follow-up into the direct-inject path) | high |
| 2026-05-23 | [Bridge terminal-name match is fragile (binding works, ergonomics)](./2026-05-23-bridge-terminal-name-fragility.md) | open | low |
| 2026-05-16 | [Voice restart OOM regression (VAD/ORT singleton lifecycle)](./2026-05-16-voice-restart-oom-regression.md) | open; overlaps BUGS.md BUG-017 (daemon heap) and BUG-023 (ORT config test drift) | medium |

## Resolved

Every resolved bug has a row in [FIXES.md](../../FIXES.md) with its commit
and a RESOLVED block in BUGS.md. The per-bug write-ups from 2026-05 to
2026-06 (session tiles, voice pill, wake word, TTS regressions, cold-start
preload, the lex-autonomy codex investigations, the supervisor wire, the
mid-reply TTS truncation) are archived under
[docs/archive/bugs/](../archive/bugs/).
