# Bug Log

## Open bugs

| Date | Bug | Status | Severity |
|------|-----|--------|----------|
| 2026-05-26 | [cc-pty voice double-talk regression — investigation only](./2026-05-26-cc-pty-double-talk-investigation.md) | investigation; no fix shipped | high |
| 2026-05-22 | [Lex cannot see worker on cold start](./2026-05-22-lex-blind-to-worker-on-cold-start.md) | open | high |
| 2026-05-22 | [Worker discovery fails for VS-Code-launched claude](./2026-05-22-worker-discovery-both-launch-paths.md) | open | high |
| 2026-05-23 | [Bridge terminal-name match is fragile (binding works, ergonomics)](./2026-05-23-bridge-terminal-name-fragility.md) | open | low |
| 2026-05-24 | [No TTS on first prompt — fresh session spawn (recurrence)](./2026-05-14-no-tts-on-first-prompt-after-restart.md) | open | medium |

## Recently closed

| Date | Bug | Status | Severity |
|------|-----|--------|----------|
| 2026-05-26 | [Supervisor wire routes to worker terminal, not Lex (Fix 34d aftermath)](./2026-05-26-supervisor-wire-routes-to-worker.md) | fixed (pending live verify), Fix 34d.1 | high |
| 2026-05-24 | [Cold-start preload pulls stale distillation despite recent ended sessions](./2026-05-24-cold-start-preload-stale-distillation.md) | fixed (pending soak), 7957666 | medium |
| 2026-05-22 | [TTS does not stop when user speaks (barge-in regression)](./2026-05-22-tts-bargein-regression.md) | fixed (pending soak), d6f094a + 6195466 + a00cea6 | high |
| 2026-05-14 | [Cross-session inject lands in worker input field but never auto-submits](./2026-05-14-bridge-inject-missing-enter.md) | fixed (pending soak) | high |
| 2026-05-14 | [VAD path uses deprecated ScriptProcessorNode](./2026-05-14-vad-scriptprocessornode-deprecation.md) | fixed (pending soak), 4ae0f0a | medium |
| 2026-05-14 | [Wake-word stuck after "Lex shut up", "Lex unmute" never fires](./2026-05-14-wake-word-unmute-stuck.md) | fixed (pending soak), c1e3bd3 + 73fc697 | medium |
| 2026-05-14 | [iOS PWA reminders not pushing](./2026-05-14-pwa-reminders-not-pushing.md) | fixed (pending soak) | medium |
| 2026-05-14 | [Voice pill inconsistent + wake-word muted](./2026-05-14-voice-pill-inconsistent-and-wake-word-muted.md) | fixed (pending soak) | medium |
| 2026-05-14 | [Enable-audio double permission prompt](./2026-05-14-enable-audio-double-permission-prompt.md) | fixed (pending soak) | medium |
| 2026-05-14 | [No TTS on first prompt after restart](./2026-05-14-no-tts-on-first-prompt-after-restart.md) | fixed (pending soak) | medium |
| 2026-05-05 | [Leftover session tiles](./2026-05-05-leftover-session-tiles.md) | closed | low |
| 2026-05-10 | [Brainstorm picker and transcripts](./2026-05-10-brainstorm-picker-and-transcripts.md) | fixed (pending soak) | medium |
| 2026-05-10 | [CC feedback prompt unanswerable](./2026-05-10-cc-feedback-prompt-unanswerable.md) | fixed (pending soak) | medium |
| 2026-05-10 | [State tracker loses live sessions](./2026-05-10-state-tracker-loses-live-sessions.md) | fixed (pending soak) | medium |
| 2026-05-11 | [Push-to-talk not releasing mic](./2026-05-11-push-to-talk-not-releasing-mic.md) | fixed (pending soak) | medium |
| 2026-05-11 | [Cannot resume past brainstorms](./2026-05-11-cannot-resume-past-brainstorms.md) | fixed (pending soak) | medium |
| 2026-05-11 | [Dashboard small screen overflow](./2026-05-11-dashboard-small-screen-overflow.md) | fixed (pending soak) | medium |

Update this table whenever a bug is added, fixed, or its status changes.

---

## Conventions

One file per investigation. Naming: `YYYY-MM-DD-short-slug.md`.

Each bug doc captures:

- **Status:** open / investigating / fixed (pending soak) / closed
- **Symptoms** the user actually saw
- **Root causes** as understood, including the layered ones we missed at first
- **Fixes shipped** with commit shas in the table so a future reader can run `git show <sha>`
- **Verification** notes — what was actually exercised
- **Open items** — soak windows, deeper rewrites that the workaround didn't address, follow-up tickets

Closed bugs stay in this folder; we don't delete history. If the same problem recurs, append a new section to the existing file rather than starting a new one — context compounds.
