# 2026-06-22 Mid-reply TTS truncation (long spoken replies cut off, never finish)

**Status:** fixed (DRIVE-QUEUE 1c, commit pending operator rebuild)

This is the canonical entry for the long-standing "Fix 24 / mid-reply TTS
truncation" item. The prior diagnosis was tier-5 and never written down;
the memory pointer (`project_devneural_midreply_tts_truncation_priority`)
tracked it as a priority but no doc existed. This entry establishes it
with a verified root cause against current code rather than the stale
guess.

## Symptom

Long spoken replies cut off partway and never finish, "like a timeout".
Reproducible by the operator: every time on a long response. Short
replies are unaffected.

## Recurrence (2026-06-22)

Resurfaced immediately after the DRIVE-QUEUE 1a/1b voice work
(`4df083c` live glue, `a1d139d` digest push, `25a65ba`/`6a732b2` live
reply-body render). The truncation tracks the live-voice path the 1a/1b
work introduced, not the historical guess.

## Verified root cause

The cut is in the live-haiku reply-body RENDER added in 1b, NOT in piper,
the WS streaming, or any pre-existing cap. Verified by reading the whole
current speak path and eliminating every other length-bounding step:

- `piper.ts` `synthesize()` - streams piper stdout PCM; no length cap, no
  timeout.
- `tts-sanitize.ts` `sanitizeForTts()` - path/url/id/markup rewrite +
  whitespace collapse; no length cap.
- `select-tts-content.ts` `selectTtsContent()` - only `clampAck()` caps
  text, and only for pre-tool ACKs, never the end_turn body.
- `lex-voice-speak-controller.ts` - Fix 51 awaits pcm `end`; streams the
  full PCM; no length/time cap.

The ONLY content-length-bounding step in the path is the render:

- `voice-haiku-wiring.ts` `renderReplyForSpeech` -> `renderSpokenAsync`
  -> `voice-haiku-glue.ts` `renderReplyLive`, which called
  `VOICE_HAIKU_MODEL` with a FIXED `max_tokens: 512`.
- A long reply's restyle exceeds 512 output tokens. Haiku generates ~512
  tokens in ~2.3s, under the 2500ms request timeout, so the request does
  NOT time out; it returns a completion that stopped on `max_tokens`,
  i.e. cut mid-sentence. `defaultCall` discards `stop_reason`, so the cut
  is invisible to the caller.
- `renderSpokenAsync`'s verbatim guard (`verifyVerbatim`) only rejects a
  candidate that DROPPED a preserve span (number / SHA / negation). A
  truncated tail of plain prose drops no preserve span, so the guard
  PASSES and the truncated text is spoken -> the reply "never finishes".
- The render prompt also said "keep it brief", compounding the loss by
  encouraging the model to shorten.

Gating: this only fires with `DEVNEURAL_VOICE_HAIKU=1` AND
`ANTHROPIC_API_KEY` set (the live-render path). Flag off / no key: the
body ships through the safe markdown-strip render (`renderForSpeech`),
which is unbounded - no truncation. So the bug is specific to the
live-voice configuration the operator enabled to use 1a/1b.

## Fix

`voice-haiku-glue.ts` `renderReplyLive`:

1. Size `max_tokens` to the input (`renderMaxTokens`): ~chars/4 tokens +
   margin, bounded `[96, 2048]`. The model is no longer told to stop
   mid-reply; a realistic spoken reply fits. A pathologically long input
   that would exceed the ceiling simply times out and the FULL safe
   render ships (complete, never truncated).
2. Completeness backstop (`looksTruncated`): for an input long enough for
   truncation to matter (>= 280 chars), if the restyle does not end on a
   sentence boundary it is treated as a cut and `renderReplyLive` returns
   `''`, so `renderSpokenAsync` falls back to the full safe render rather
   than speaking a sentence that never finishes.
3. Render prompt re-worded from "keep it brief" to "say ALL of it, do not
   summarize, omit, or cut it short" - renderer, not re-thinker.

Net guarantee: the spoken body is EITHER a complete warm restyle OR the
complete safe render. It is never a truncated restyle. Additive +
flag-gated; flag-off path byte-identical.

## Regression tests

- `tests/voice-haiku-glue.test.ts`: `max_tokens` scales with input
  (> 512 for a long reply); a long restyle that does not end on a
  sentence boundary returns `''` (caller ships full safe render); a
  complete long restyle is kept; the completeness guard does not
  over-trigger on short replies.
- `tests/voice-haiku-wiring.test.ts`: flag ON, a long reply whose render
  is cut speaks IN FULL (safe render), tail included.
