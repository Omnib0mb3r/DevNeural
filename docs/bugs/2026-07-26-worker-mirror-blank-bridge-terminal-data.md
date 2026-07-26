# Worker terminal mirror is blank — bridge terminal-data mirror not flushing

**Status:** open — DEFERRED (separate from the Stream Deck linking bug; do not conflate)
**Date:** 2026-07-26
**Severity:** medium

## Symptom

On the dashboard worker-terminal panel, the **header renders** (context badge, pill) but the **terminal body shows nothing** — no output streams from the worker's VS Code / Claude Code terminal. Lex's own mirror works perfectly.

## Why Lex works and the worker doesn't

Lex runs as a **daemon-PTY** (`pty-host.ts`): the daemon owns both ends and pumps stdout straight into the terminal-stream ring, so its mirror "just works." The **worker** runs in a **VS Code integrated terminal via the 09-bridge**, so its bytes must travel VS Code → bridge → daemon ring. That path is what is broken.

## What was verified (2026-07-26)

- Proposed API IS enabled: `%APPDATA%/Code/User/argv.json` has `"enable-proposed-api": ["omnib0mb3r.devneural-bridge"]`.
- The bridge dev source/dist contains the mirror code (`onDidWriteTerminalData`, gated by the `terminalDataWriteEvent` proposal — extension.ts ~1196-1478).
- Installed extension: `~/.vscode/extensions/omnib0mb3r.devneural-bridge-0.1.0/`.
- Live mirror state (`<DATA_ROOT>/session-bridge/.mirror-state.json`): `api_available:true, subscribed:true, tracked_terminals:0`, all `last_flush_*` null, and `updated_at` **frozen at 2026-07-23** even though the bridge heartbeat is fresh.
- A full VS Code **window reload did NOT change the mirror state** (still frozen, still `tracked_terminals:0`) and it killed the running worker session + its in-flight research. So reload is not the fix and is destructive.

## Leading root cause (not yet fixed)

The running bridge extension's **terminal-data mirror writer is not executing / not tracking terminals** in the current window: presence writer runs (fresh heartbeat) but the mirror writer's state hasn't been touched since 2026-07-23 and tracks 0 terminals. Most likely the installed VSIX (0.1.0) is a stale/older build whose mirror path does not fire, or the proposed-API terminal-data events are not being delivered to it. Needs confirmation with the VS Code extension-host console for the `[mirror]` log lines.

## Hard constraints from the operator

- **Keep the worker mirror ported from the VS Code / Claude Code terminal via the bridge.** Do NOT convert the worker to a daemon-PTY to "fix" the mirror.
- **Do NOT change how Lex's mirror/session works.**

## Candidate next steps (when picked up)

- Read the VS Code extension-host console for `[mirror]` lines to see whether `onDidWriteTerminalData` is actually firing in the worker window.
- Rebuild `09-bridge` from current source, repackage the VSIX, reinstall (`code --install-extension`), reload the window (when no research is running), and confirm `tracked_terminals` climbs and `last_flush_*` populate.
- If the proposed API is silently not delivering events, verify VS Code version compatibility and the extension's `enabledApiProposals` in its packaged `package.json`.
