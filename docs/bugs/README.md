# Bug Log

## Open bugs

| Date | Bug | Status | Severity |
|------|-----|--------|----------|
| 2026-05-14 | [iOS PWA reminders not pushing](./2026-05-14-pwa-reminders-not-pushing.md) | open | medium |

## Recently closed

| Date | Bug | Status | Severity |
|------|-----|--------|----------|
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
