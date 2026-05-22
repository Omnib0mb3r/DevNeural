# DevNeural docs index

One-line pointers to every file under `docs/`. Mirrors the per-brainstorm
`MEMORY.md` shape; the daemon injects these bullets into Lex's live_state
on every voice turn and into the worker's SessionStart so neither side
forgets what reference material exists.

When you add or rename a doc, update this file in the same commit. Title
in brackets must match the filename (sans `.md`) so a grep on the title
lands the file in one hop. One-liners describe what the doc is FOR
(purpose), not a line-by-line summary.

## Top-level

- [CLEANUP-TODO](CLEANUP-TODO.md) - janitorial backlog that does not belong in a wave plan; append as discovered, strike when done
- [DISASTER-RECOVERY](DISASTER-RECOVERY.md) - manual snapshot + restore runbook to run before any risky daemon upgrade or migration
- [FUTURE-FEATURES](FUTURE-FEATURES.md) - forward-looking scope index; planned-but-not-built items with one-line "why still relevant"
- [FUTURE-SECURITY-CONCERNS](FUTURE-SECURITY-CONCERNS.md) - running log of intentional security trade-offs and the debt each one carries
- [HANDOVER-2026-05-09-second-brain-strengthening](HANDOVER-2026-05-09-second-brain-strengthening.md) - tracking doc for the wiki/RAG/Lex pipeline strengthening pass on 2026-05-09
- [HANDOVER-2026-05-10-phase-two-wave-1-day-1](HANDOVER-2026-05-10-phase-two-wave-1-day-1.md) - resume pointer for Phase Two Wave 1 days 1-3 work
- [HANDOVER-2026-05-10-phase-two-wave-2-complete](HANDOVER-2026-05-10-phase-two-wave-2-complete.md) - resume pointer at Wave 2 completion
- [HANDOVER-overnight-2026-05-14](HANDOVER-overnight-2026-05-14.md) - overnight Lex autonomous supervision run, 2026-05-14
- [HANDOVER-overnight-2026-05-16](HANDOVER-overnight-2026-05-16.md) - overnight handover, 2026-05-16
- [HANDOVER-overnight-supervision](HANDOVER-overnight-supervision.md) - overnight supervision handover, 2026-05-12
- [HOW-TO-dashboard-serving](HOW-TO-dashboard-serving.md) - architecture + ops for how the dashboard bundle is served (Next.js + static export + daemon proxy)
- [HOW-TO-dashboard-ux](HOW-TO-dashboard-ux.md) - user-facing reference for dashboard panels and their interaction contracts
- [HOW-TO-supervision-pipelines](HOW-TO-supervision-pipelines.md) - architectural deep dive for bridge presence, cross-session inject, smart compact, event supervision, brainstorm threading, auto-advance
- [HOW-TO-voice-and-push](HOW-TO-voice-and-push.md) - voice/TTS knob reference, text-input-bypasses-TTS rule, web-push channel notes
- [INDEX](INDEX.md) - this file; the docs index injected into Lex live_state and worker SessionStart
- [PLAN-2026-05-12-evening](PLAN-2026-05-12-evening.md) - evening work plan written by Lex for the worker on 2026-05-12
- [POSTMORTEM-2026-05-17-voice-tts-stale-shell](POSTMORTEM-2026-05-17-voice-tts-stale-shell.md) - postmortem for voice TTS silence after overnight rebuild on 2026-05-17
- [SESSION-HANDOVER](SESSION-HANDOVER.md) - "first file a new Claude reads when starting fresh"; the canonical resume pointer
- [SESSION-START-INJECTIONS](SESSION-START-INJECTIONS.md) - registry of every payload injected via SessionStart additionalContext
- [SMOKE-lex-session-rewrite-2026-05-16](SMOKE-lex-session-rewrite-2026-05-16.md) - verification log for the Lex session rewrite commit 5af07d0
- [SMOKE-TEST](SMOKE-TEST.md) - live smoke-test checklist; items shipped in code but not yet verified on real hardware
- [voice-commands](voice-commands.md) - canonical reference for every wake-word and voice command DevNeural recognises

## Subfolders

- [bugs/](bugs/) - active bug log; appended-to, never multiplied. Open bugs in `bugs/README.md`; per-bug docs are dated files with root-cause sections
- [install/](install/) - installation, prerequisites, file/path layout, troubleshooting, recovery, audio/video/heartbeat/notifications/tailscale subnotes
- [spec/](spec/) - architecture and design specs (FUNCTIONAL-SPEC, PROJECT-ANCHORS, SMART-COMPACT, EVENT-DRIVEN-SUPERVISION, WAVE/PHASE plans, codex reviews, panic button, etc.)
