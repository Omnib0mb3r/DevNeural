# Start Claude one-click spawn stalls at Claude Code first-run "trust this folder" prompt

**Status:** fix committed (72b332b) — pending daemon rebuild + restart + live verify
**Date:** 2026-07-26
**Severity:** medium

## Symptoms the user actually saw

- Pressed "Start Claude" on a brand-new scaffolded project tile (`dropship-01`, freshly cloned from `dev-template`).
- A VS Code window opened at the folder and a Claude session appeared to launch, but the daemon showed **zero live sessions** and Lex could not see or inject to any worker.
- No `~/.claude/projects/C--dev-Projects-dropship-01/` transcript existed, so nothing was PTY-bound.
- User had to manually press `1` at the terminal's "Do you trust the files in this folder?" prompt. The instant they did, the session initialized, wrote its transcript, and the daemon flipped it to live (`c79dfeb9-...`).
- User expectation: pressing Start should do everything end to end with no manual keypress.

## Root cause

The Start pipeline itself works correctly: it queues the workspace-inject marker, runs `code -n <cwd>`, the bridge extension attaches and posts a fresh presence file, and it PTY-binds. Verified all of this fired.

The single blocker is **external to DevNeural**: Claude Code gates every folder it has never opened before behind a one-time "trust the files in this folder?" prompt. Acceptance is stored per-path in `~/.claude.json` as `projects["<path>"].hasTrustDialogAccepted`. A brand-new scaffolded folder has never been accepted, so the spawned claude blocks at that prompt *before* it can init a session, write a transcript, or complete the bridge/PTY handshake.

This is why the pipeline "works 100 times" on already-opened projects but stalls on a freshly created one: existing folders are already trusted; new ones are not. The start-claude path has no step that pre-clears the trust gate.

## Fix (committed 72b332b, pending activation)

Shipped as `seedProjectTrust` in `07-daemon/src/dashboard/projects-new.ts`, called from `queueProjectBootstrap` (the single chokepoint both the Start Claude button and the new-project spawn funnel through) before the launch marker is queued. Pre-seeds the trust flag at first-spawn time, scoped to the workspace being launched:

- When the new-project / start-claude flow prepares a folder, patch `~/.claude.json` to add `projects["<abs path>"]` with `hasTrustDialogAccepted: true` (plus the onboarding flags `hasCompletedProjectOnboarding` / `projectOnboardingSeenCount`) **before** the first claude launch.
- Race-free: it runs before any claude opens that folder, so there is no concurrent-writer conflict with a running session.
- Use an atomic read-modify-write on `~/.claude.json` (it holds secrets and the full project map; do not clobber).
- Scope strictly to DevNeural-created project paths so this never blanket-trusts arbitrary directories.

Home: the daemon start-claude path (every future project benefits), mirrored into the "Starting a New Project" scaffold steps in global CLAUDE.md.

Activation note: the daemon runs compiled `dist`, and a daemon restart recycles the Lex session, so shipping this needs a deliberate rebuild + restart, timed by the user.

## Verification

- Confirmed live session appears only after the manual trust acceptance (before: `sessions: []`; after: 1 live session, worker responds to a test prompt).
- Bridge presence file present and fresh throughout, proving the block was pre-session-init, not a bridge/PTY failure.

## Open items

- [x] Implement the pre-trust seed in the start-claude path (72b332b, `seedProjectTrust` in queueProjectBootstrap; 7 passing tests).
- [x] Flag set: `hasTrustDialogAccepted` + `hasCompletedProjectOnboarding` (matches a fully-onboarded entry read from a live ~/.claude.json).
- [ ] Rebuild + restart daemon to activate (session-recycling, user-timed). Daemon dist rebuilt 2026-07-26 14:01; restart still pending.
- [ ] Live verify: Start Claude on a fresh scaffolded folder reaches a live session with zero keypresses.
- [ ] Known trade-off: ~/.claude.json is shared with live sessions; the seed's read-modify-write has a small lost-update window (accepted, see code comment).
