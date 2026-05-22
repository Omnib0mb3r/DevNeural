# 2026-05-22 Worker discovery fails for VS-Code-launched claude

**Status:** open

## Symptom

Two worker launch paths must work end to end:
1. Dashboard "Start Claude" (daemon spawns claude.exe via node-pty, daemon-owned).
2. User opens VS Code, types `claude` in a terminal (bare args, no `--session-id`).

Today path 2 is broken. Daemon thinks the project is live (presence file + latched UUID), but injects do not land in the worker prompt. Lex has no path to talk to a VS-Code-launched worker.

## What we know

- VS Code-typed claude.exe has no session-id in its command line; bridge can only associate the terminal with a UUID via jsonl mtime latch (`cc-session-latch.ts`).
- Bridge presence file is written by whichever bridge wins the latch race based on jsonl mtime, NOT by whichever bridge has the terminal in `vscode.window.terminals`.
- Today's session: bridge in window1 latched UUID c2dd85f8, wrote presence file, but `vscode.window.terminals.length === 0` in that window. Worker terminal is in a different window/process whose bridge either didn't activate or didn't claim the UUID.
- Bridge log shows `[skip] no terminal in this window; another bridge instance is expected to handle it` repeated; offset still advances; messages silently dropped.
- Inject endpoint reports `accepted` based on file write, not delivery.

## Action

Close the gap between "presence file claims UUID" and "bridge can actually deliver." Likely shape: bridge stamps a `has_terminal_for_uuid` flag in its presence payload per `cc_session_id`, computed by walking its own terminals and matching process tree to the claude.exe owning that UUID. Daemon routes inject only to presence files where that flag is true for the target UUID. Returns structured `no-deliverable-bridge` when none claim.

Acceptance: both launch paths produce a worker that Lex can inject to. Inject endpoint response reflects actual delivery, not file write success. Bridge offset does not advance for messages that were not delivered.

## Root cause (diagnosis, 2026-05-22)

Three layered failures, all consistent with the existing design but each one missing a deliverability check:

1. **Latch is per-cwd, not per-window-with-terminal.** `09-bridge/src/cc-session-latch.ts` resolves the active CC session UUID by jsonl mtime under `~/.claude/projects/<slug>/`, with a 60s anti-flap gate. The bridge tick loop in `09-bridge/src/extension.ts` calls this via `ccSessionLookup` and then writes the presence file with that UUID regardless of `vscode.window.terminals.length`. When two VS Code windows share a cwd, whichever bridge ticks first wins the latch and stamps the presence; the bridge that actually owns the worker terminal may have arrived after the anti-flap gate closed and therefore never writes presence claiming that UUID.

2. **Presence payload has no `has_terminal_for_uuid` flag.** `09-bridge/src/presence.ts:26-32` `PresencePayload` carries only `workspace`, `cwd`, `bridge_id`, `updated_at`, and `cc_session_ids?: string[]`. It is a claim of UUID ownership, not a claim of deliverability. The daemon reads these via `07-daemon/src/dashboard/bridge-presence.ts` and routes injects to the first record whose `cc_session_ids` includes the target UUID, without asking "does this bridge have a real terminal for that UUID right now."

3. **Inject path treats queue-file-write as delivery.** `crossSessionInject` (`07-daemon/src/lex/cross-session-inject.ts:286-323`) falls through to `queueSessionPromptFn(target_session, text)` for any non-PTY worker and returns `{ok:true, decision:'accepted', transport:'bridge'}` purely on queue-write success. The consumer side at `09-bridge/src/extension.ts:381-400` calls `handleMessage`, which calls `findTargetTerminalAsync()`; when that returns undefined the channel logs `"[skip] no terminal in this window; another bridge instance is expected to handle it"` (:394-399). Offset advances during the parse loop regardless of skip outcome, so the marker is consumed-but-silently-dropped on the wrong bridge while no other bridge ever reads it (the file is named after the UUID and only one bridge claimed it).

Net: the daemon picks "the bridge that claimed the UUID" instead of "the bridge that has a terminal for the UUID," and the bridge that claimed it has no terminal. Marker lands in a sinkhole; daemon reports `accepted`; bridge offset advances; worker never sees the prompt. The fix shape sketched in the Action section (bridge stamps `has_terminal_for_uuid` per `cc_session_id` based on its own `vscode.window.terminals` + process-tree match; daemon routes only to presence files where that flag is true; structured `no-deliverable-bridge` when none claim; bridge does NOT advance offset on `[skip]`) is consistent with the existing presence reconcile and cross-session-inject substrate. This is the same root deliverability gap as bug `2026-05-22-lex-blind-to-worker-on-cold-start.md`; fixing it here fixes both.
