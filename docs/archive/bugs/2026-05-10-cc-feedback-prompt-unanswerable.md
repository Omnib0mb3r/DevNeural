# Bug: cc-feedback-prompt-unanswerable

**Status:** Fixed (pending soak) — 2026-05-11, Wave 3 fixup sprint.

**Date opened:** 2026-05-10

---

## Symptoms

When Claude Code's built-in feedback prompt fires (asking the user to rate a
session or tool result), Lex receives the prompt but cannot answer it
meaningfully. The symptom is Lex responding with a confused or off-topic message,
or trying to treat the numeric rating request as a brainstorm prompt. In the worst
case, Lex answers "1" (the first rating option) as if it were dictation input,
which Claude Code may interpret as a valid rating submission.

---

## Root cause

The voice WS pipeline (`07-daemon/src/voice/lex-voice-ws.ts`) injects every
transcribed utterance into the active Lex PTY without first checking whether the
PTY's current context is a first-party Lex brainstorm or a system-generated
Claude Code feedback prompt.

Claude Code occasionally pauses a session and displays a rating or feedback prompt
natively in the PTY. When this happens:

1. The user speaks (or types) something to Lex.
2. The WS transcribes and injects the text.
3. The injection goes to the PTY, which is displaying the feedback prompt.
4. Claude Code interprets the injected text as the user's answer to the feedback prompt.
5. Lex then gets whatever Claude Code returns (its own response to "Lex's rating").
6. Lex tries to make sense of an unexpected rating-response context.

The feedback prompt is injected via stdout; the daemon has no way to detect it
because it does not parse Claude Code's native terminal UI state.

---

## Analysis

The `hook-runner.ts` file handles `UserPromptSubmit` hooks which fire on actual
user prompts. The feedback prompt is a separate UI layer in the Claude Code
terminal, not a standard `UserPromptSubmit` event. The daemon has no hook for it.

The `ptyInject` function in `pty-host.ts` writes text to the PTY stdin
unconditionally. It does not check PTY state.

---

## Mitigations considered

**Option A (preferred):** Detect feedback prompts by pattern-matching the PTY
stdout buffer. The feedback prompt contains recognizable strings like "How would
you rate" or "1 = thumbs down, 5 = thumbs up" etc. If detected, suppress
injection and surface a notice to the voice WS client ("Lex: CC feedback prompt
active; voice injection paused").

**Option B:** Add a PTY state flag `awaitingFeedback` that the stdout watcher sets
when it sees feedback-prompt patterns. Voice WS checks the flag before injecting.

**Option C (band-aid):** Add a system prompt rule in `IDENTITY` telling Lex: "If
you receive a numeric rating prompt from Claude Code (1-5), respond with 3 and do
not riff on the rating. This is a system artifact, not a user request."

---

## Deferred

**Wave 3 Lane B, step 42.** Implementing reliable PTY-stdout pattern matching
requires changes to `pty-host.ts` stdout buffering, which has wider blast radius
than this lane's scope. Option C (prompt rule) is a low-risk interim fix that
prevents the worst-case (Lex treating the rating as dictation input).

**Interim fix shipped here:** Add a self-check rule to `IDENTITY` in
`system-prompt.ts` so Lex recognizes and handles CC feedback prompts gracefully.

This is a targeted prompt change with no code-path changes, low risk.

---

## Fix shipped

Added to `SELF_CHECK` in `07-daemon/src/lex/system-prompt.ts`:

```
12. If the turn looks like a Claude Code system rating prompt ("How would you
    rate", "1 = thumbs down", "Rate this interaction"), respond with 3 (neutral)
    in one word and do not elaborate. These are telemetry prompts, not user
    requests. Do not treat numeric input in this context as brainstorm dictation.
```

Commit: included in the Wave 3 Lane B spec-doc commit (no behavior change until
system-prompt.ts is updated in a follow-up commit).

---

## Full fix shipped (Wave 3 fixup, 2026-05-11)

Option A from the mitigation list landed end-to-end:

- `07-daemon/src/dashboard/pty-host.ts`:
  - `PtyHandle` gains `awaitingSystemPromptUntil: number` (epoch ms).
  - `CC_SYSTEM_PROMPT_RE` covers the rating prompts (`How would you
    rate`, `1 = thumbs down`, `Rate this interaction`) and the
    related `Continue? (y/n)` + `Press Enter to continue` overlays.
  - `pty.onData` scans every stdout chunk; when the regex matches,
    the handle's `awaitingSystemPromptUntil` is pushed forward by
    `SYSTEM_PROMPT_HOLD_MS` (90s). Repeated hits keep the window
    alive without re-entering the regex path on every byte.
  - New public helper `isAwaitingSystemPrompt(ptyIdOrSession)` lets
    auto-injection paths consult the gate.
- `07-daemon/src/voice/lex-voice-ws.ts`: before forwarding a
  transcribed utterance to `ptyInject`, call
  `isAwaitingSystemPrompt(state.bindKey)`. If true, emit an
  `{t:'error', code:'cc-feedback-prompt-active', message:...}` event
  to the WS client and skip the inject. The user can still answer
  the prompt manually in the terminal; typed-text paths in the
  dashboard are intentionally not gated because the user has the
  prompt visible and is choosing to send.
- Tests in `07-daemon/tests/cc-feedback-prompt-detect.test.ts`
  pin the regex contract (8 cases: 5 positive matches, 2 negatives,
  1 sanity check on the hold window duration).

The SELF_CHECK rule from the interim Wave 3 fix stays in place as a
belt-and-suspenders layer in case the regex misses a new prompt
variant.

## Verification

1. `npx vitest run tests/cc-feedback-prompt-detect.test.ts`: 8/8 pass.
2. `tsc --noEmit` clean on `07-daemon`.
3. Manual: trigger a CC rating prompt in a live PTY; voice WS now
   surfaces the block message instead of injecting the next
   transcribed utterance.
