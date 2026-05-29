# DevNeural docs index

One-line pointers to every active file under `docs/`. The daemon
injects these bullets into Lex's live_state on every voice turn and
into the worker's SessionStart so neither side forgets what reference
material exists. Historical handovers, postmortems, and superseded
plans live under `docs/archive/` and are deliberately omitted from
this index.

When you add or rename a doc, update this file in the same commit.
Title in brackets must match the filename (sans `.md`) so a grep on
the title lands the file in one hop. One-liners describe what the doc
is FOR (purpose), not a line-by-line summary.

## Top-level

- [ARCHITECTURE-MAP](ARCHITECTURE-MAP.md) - one-page map of the daemon / dashboard / bridge / voice / wiki layers and how they wire together
- [DISASTER-RECOVERY](DISASTER-RECOVERY.md) - manual snapshot + restore runbook to run before any risky daemon upgrade or migration
- [FUTURE-FEATURES](FUTURE-FEATURES.md) - forward-looking scope index; planned-but-not-built items with one-line "why still relevant"
- [FUTURE-SECURITY-CONCERNS](FUTURE-SECURITY-CONCERNS.md) - running log of intentional security trade-offs and the debt each one carries
- [HANDOVER](HANDOVER.md) - single rolling resume pointer; the first file a new Claude reads when starting fresh
- [HOW-TO-dashboard-serving](HOW-TO-dashboard-serving.md) - architecture + ops for how the dashboard bundle is served (Next.js + static export + daemon proxy)
- [HOW-TO-dashboard-ux](HOW-TO-dashboard-ux.md) - user-facing reference for dashboard panels and their interaction contracts
- [HOW-TO-dev-vs-prod-dashboard](HOW-TO-dev-vs-prod-dashboard.md) - port 3000 vs 3747; what each one serves; which build step makes which change live; Tailscale dev/prod switch
- [HOW-TO-supervision-pipelines](HOW-TO-supervision-pipelines.md) - architectural deep dive for bridge presence, cross-session inject, smart compact, event supervision, brainstorm threading, auto-advance
- [HOW-TO-voice-and-push](HOW-TO-voice-and-push.md) - voice/TTS knob reference, text-input-bypasses-TTS rule, web-push channel notes
- [INDEX](INDEX.md) - this file; the docs index injected into Lex live_state and worker SessionStart
- [SESSION-START-INJECTIONS](SESSION-START-INJECTIONS.md) - registry of every payload injected via SessionStart additionalContext
- [SMOKE-TEST](SMOKE-TEST.md) - live smoke-test checklist; items shipped in code but not yet verified on real hardware
- [voice-commands](voice-commands.md) - canonical reference for every wake-word and voice command DevNeural recognises

## Subfolders

- [archive/](archive/) - historical handovers, postmortems, superseded waves and phase plans, the pre-FUNCTIONAL-SPEC architecture drafts; read only for provenance
- [bugs/](bugs/) - active bug log; appended-to, never multiplied. Open bugs in `bugs/README.md`; per-bug docs are dated files with root-cause sections
- [install/](install/) - installation, prerequisites, file/path layout, troubleshooting, recovery, audio/video/heartbeat/notifications/tailscale subnotes
- [spec/](spec/) - current architecture and design specs (FUNCTIONAL-SPEC, LEX-AUTONOMY-PAYLOAD-SPEC, LEX-STANDALONE-SUPERVISION, COALESCE-UTTERANCE-QUEUE, PROJECT-ANCHORS, SMART-COMPACT, EVENT-DRIVEN-SUPERVISION, PANIC-BUTTON, PHASE-8-RELIABILITY-PLAN, STREAMDECK-DEVNEURAL-ALIGNMENT, FUTURE-DAEMON-SPLIT, codex reviews)
- [superpowers/](superpowers/) - shared "superpower" skill reference docs consumed by plugin-side hooks
