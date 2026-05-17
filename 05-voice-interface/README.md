# 05-voice-interface — archived planning docs

This directory holds the v1 voice interface planning corpus
(`claude-research.md`, `claude-plan.md`, `claude-plan-tdd.md`,
`claude-spec.md`, `claude-interview.md`,
`claude-integration-notes.md`, `implementation/`). It predates
Phase 7 by several months and reflects the pre-Lex architecture
that targeted a standalone STT/TTS service.

**Nothing here ships at runtime.** No daemon module imports from
this directory, no test references it, and `dist/` is a stale local
build artifact from the original TDD pass.

For the live voice stack see:

- Phase 7 voice loop: `07-daemon/src/voice/` (whisper-server,
  Piper, lex-voice-ws, lex-voice-commands, audio-bundle,
  meeting-audio-purge) and `08-dashboard/components/VoiceClient.tsx`
  for the browser pipeline.
- Phase Two follow-on work (cross-session supervision, awareness
  broadcaster, personality fine-tune): `docs/spec/PHASE-TWO-IMPLEMENTATION.md`.
- Active multi-session handover notes: `docs/HANDOVER-*.md` and
  the latest `docs/POSTMORTEM-*.md` files.

These planning docs are retained for historical reference only.
Treat them as an archived design pass; do not edit them to track
current behavior.
