# Worker terminal mirror is blank — bridge terminal-data mirror not flushing

**Status:** open — separate track from the Stream Deck linking bug (do not conflate)
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

## CONFIRMED root cause (verified 2026-07-26 against the live VS Code install + bridge log)

VS Code **1.130.0 has removed the `terminalDataWriteEvent` proposed API** that
the mirror is built on. Evidence:

- Live bridge output channel log (window started 13:37): `[mirror] startup
  failed (non-fatal): Extension 'omnib0mb3r.devneural-bridge' CANNOT use API
  proposal: terminalDataWriteEvent. Its package.json#enabledApiProposals
  declares: (empty) but NOT terminalDataWriteEvent.`
- Both source AND installed `package.json` DO declare `terminalDataWriteEvent`,
  and `argv.json` enables it. So the manifest is correct; VS Code simply no
  longer knows the proposal (it strips unknown proposals → "declares: empty").
- `grep terminalDataWriteEvent` across the VS Code 1.130 app resources → **0
  hits**. The proposal is gone from the product.

The mirror subscription therefore throws at startup, is caught non-fatally, and
never tracks a terminal or rewrites `.mirror-state.json` (hence the frozen
2026-07-23 file and `tracked_terminals:0`). NOT a stale build (installed
extension.js == source, 62 KB, 2026-07-15), NOT a reload issue (a reload does
not resurrect a removed API), NOT the daemon.

## Fix = migration (no config tweak can restore a removed API)

Rewrite the bridge's terminal capture (`09-bridge/src/extension.ts`, the
`onDidWriteTerminalData` path ~1196-1478) onto VS Code's current SUPPORTED
terminal-read API: **shell integration** —
`window.onDidStartTerminalShellExecution(e => { for await (const chunk of
e.execution.read()) { flush(chunk) } })`. Keep the same flush → daemon
terminal-stream ring → dashboard mirror pipeline downstream. Repackage the VSIX
and reinstall to test (reload the window when no worker research is running).

Caveat to design: shell integration streams a command's output; Claude Code is
a long-lived full-screen TUI, so validate that `execution.read()` streams its
redraws continuously (it should, as one long execution) and that ANSI/cursor
bytes arrive intact for xterm on the dashboard side.

Constraints unchanged: keep bridge-ported, do NOT daemon-PTY the worker, do NOT
touch Lex's mirror.

## Hard constraints from the operator

- **Keep the worker mirror ported from the VS Code / Claude Code terminal via the bridge.** Do NOT convert the worker to a daemon-PTY to "fix" the mirror.
- **Do NOT change how Lex's mirror/session works.**

## Candidate next steps (when picked up)

- Read the VS Code extension-host console for `[mirror]` lines to see whether `onDidWriteTerminalData` is actually firing in the worker window.
- Rebuild `09-bridge` from current source, repackage the VSIX, reinstall (`code --install-extension`), reload the window (when no research is running), and confirm `tracked_terminals` climbs and `last_flush_*` populate.
- If the proposed API is silently not delivering events, verify VS Code version compatibility and the extension's `enabledApiProposals` in its packaged `package.json`.
