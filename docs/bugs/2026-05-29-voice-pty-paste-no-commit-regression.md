# Voice PTY paste lands as `[Pasted text #N +5 lines]`, never submits

Date: 2026-05-29
Component: 07-daemon/src/voice/lex-voice-ws.ts (direct-inject path) +
07-daemon/src/dashboard/pty-host.ts (ptyInject)
Severity: high (voice mode unusable; every utterance needs manual Enter)
Status: investigation (no code this round)

## 1. Reproduce path

1. Operator opens voice mode on a brainstorm bound to a Lex CC PTY
   (`state.runtimeMode === 'cc-pty'`, `state.bindKey` non-null,
   `state.brainstormId` non-null).
2. Operator speaks one utterance. STT lands; `handleUtteranceEnd`
   runs through the voice-command matcher (no command), through the
   wake-during-TTS gate (clean), through the `awaitingResponseSince`
   mid-turn-no-tts gate (no queue), and falls through to the direct
   inject branch at `07-daemon/src/voice/lex-voice-ws.ts:2147`.
3. `ptyInject(state.bindKey, snapshotBlock + gateNote +
   partialChainBlock + voiceTag + result.text, true)` returns
   `{ok:true}`.
4. The Lex CC TUI renders `[Pasted text #N +5 lines]` in the input
   buffer. The cursor sits after the indicator. Lex never receives
   a turn; the worker stays idle.
5. Operator presses Enter manually in the terminal -> the buffered
   paste submits and Lex replies normally.

Observed continuously after the 2026-05-29 ~14:54Z daemon restart
(pid 52160). Each voice utterance ends in the same paste-indicator
no-submit state.

## 2. Per-hypothesis evidence

### Hypothesis 1 — stale pty handle after daemon restart (FALSIFIED for the literal phrasing)

`state.bindKey` is assigned at `lex-voice-ws.ts:640` from
`handle.sessionId ?? handle.ptyId` during the hello handshake. The
state is local to the active WS socket; the daemon restart at
~14:54Z killed every prior socket. A fresh voice WS connection
re-handshakes against the post-restart `ptys` map. There is no
mechanism for a pre-restart `bindKey` value to survive into the new
process; the closure that holds it (`createState()` per socket) is
recreated.

For the symptom to manifest, `ptyInject` MUST find a live handle
(otherwise it would return `{ok:false, error:'pty not found'}` and
the WS would send `t:'error', code:'inject'`). The observed
`ok:true` proves a live handle was resolved. The primary
`pty.write(payload)` therefore landed in a real ConPTY — and the
`[Pasted text #N +5 lines]` rendered by CC confirms the bytes
actually reached CC's input reader.

What the hypothesis *could* still be pointing at:
post-restart, the daemon respawned the Lex CC PTY (Lex auto-resume
flow). The new PTY has a different `ptyId` but the same
`sessionId` (CC reuses the jsonl session uuid on resume). If the
voice WS's hello-ack registered `bindKey` BEFORE
`sessionToPty.set(sessionId, newPtyId)` ran in `pty-host.ts:282`,
`getPtyBySession` would return undefined and `ptyInject` would
fail — but observed behaviour says it succeeded. So this race is
either not occurring or has already been won by the new handle by
the time STT completes.

Verdict: handle reference is fresh and live. Hypothesis 1 in its
literal form is falsified.

### Hypothesis 2 — Fix 40 speak-queue (be14396) introduced a bypass path (FALSIFIED)

`07-daemon/src/voice/lex-voice-speak-controller.ts` (new in Fix 40)
owns piper lifecycle ONLY: `speak()` enqueues, `runQueue()` spawns
piper, `killActive()` cancels. It does not call `pty.write`,
`ptyInject`, or anything that touches the bound CC PTY.

```
$ grep -n "ptyInject\|pty.write\|handle.pty\|state.bindKey" \
      07-daemon/src/voice/lex-voice-speak-controller.ts
(no matches)
```

The inject path in `handleUtteranceEnd` (line 2147) is unchanged by
Fix 40; it still calls the same `ptyInject` from `pty-host.ts`.
Fix 40 does not introduce a bypass; the regression must lie
elsewhere. Verdict: hypothesis 2 falsified.

### Hypothesis 3 — speak-queue teardown clears the 1s bare-CR nudge timer (FALSIFIED)

The nudge timer is a local `const t = setTimeout(...)` inside
`ptyInject` (`pty-host.ts:802`). Its identifier never escapes the
function; nothing outside can call `clearTimeout(t)`. Search
confirms no external clear:

```
$ grep -rn "clearTimeout" 07-daemon/src/voice/
(matches only unrelated timers — utterance buffer flush, sample
 throttle; none with the nudge handle)
```

The timer is also `.unref()`-ed, so daemon shutdown does not block
on it but also does not auto-cancel it; the kernel still fires the
callback on the live event loop. Verdict: hypothesis 3 falsified.

### Hypothesis 4 — handle.exited flips between atomic write and 1s nudge (NEEDS LOG EVIDENCE)

If the PTY died inside the 1-second window, the nudge guard
`if (!handle!.exited)` would short-circuit and the `\r` would never
land. This is observable via daemon log:

```
[pty-host] exit pty=<id> session=<sid> code=<n> signal=<s>
  last_command=<JSON-quoted last write>
```

Confirmation requires checking the daemon log around the symptom
window for any `[pty-host] exit` line whose timestamp is within
~1.5s of a voice inject. The reproduction is continuous (every
utterance fails the same way) but the Lex CC PTY does not die
between utterances — the operator does not need to relaunch Lex
between failures. A continuous-die-and-respawn pattern would also
show up as fresh `hello-ack` cycles in the voice WS log. Neither
is observed in the user's reproduction note.

Verdict: hypothesis 4 is the wrong shape for the observed symptom.
The PTY is healthy; the writes succeed at the byte level (CC's
paste indicator proves the bytes arrived); the trailing CR simply
fails to function as a commit.

### Confirmed: paste-detection consumes both CRs (HIGH likelihood)

The actual cause class matches FIXES.md row 32 verbatim. Fix 32
documents that on bridge-attached workers, the one internal 1000ms
nudge inside `ptyInject` was observably insufficient, and the
mid-turn flush path therefore stamps an additional explicit bare-CR
at 850ms post-primary inside `_flushPendingUtterancesImpl`
(`lex-voice-ws.ts:498-507`). Fix 32 ships this belt-and-suspenders
explicitly for the QUEUED path; the DIRECT voice inject path at
`lex-voice-ws.ts:2147` does NOT have the same explicit 850ms
follow-up — it relies solely on `ptyInject`'s internal 1000ms
nudge.

The Lex CC PTY is a daemon-spawned ConPTY, not bridge-attached, but
CC's TUI runs the same paste-detection logic in either case. The
multi-line payload (snapshotBlock + gateNote + partialChainBlock +
voiceTag + result.text — five-plus lines, hence the literal
"+5 lines" in the indicator) triggers CC's smart-paste UI. The
trailing `\r` inside the atomic write is consumed as paste content,
not as Enter. The 1000ms internal nudge `\r` is consumed for the
same reason — CC's paste-mode UI does not accept a raw `\r`
delivered later as a submit either; the operator's manual Enter
press, which CC reads as a keysym event rather than a raw byte,
does succeed.

Why this is correlated with "after the most recent daemon restart":
the multi-line payload threshold (snapshot + gate + partials +
voice tag + utterance) has expanded over time as new context
sections landed (Fix 43 freshness, Fix 47 codex 10c voice context,
LX-11b tool gate notes, partial-chain N-deep barge). Pre-restart
sessions may have had shorter payloads that did not trip CC's
multi-line paste detector. The post-restart payload, with every
context block at its latest content, predictably exceeds the
threshold.

## 3. Confirmed root cause

`07-daemon/src/voice/lex-voice-ws.ts:2147` direct-inject path
relies on `ptyInject`'s internal 1000ms bare-CR nudge as its sole
commit guarantee. CC's TUI paste-detection swallows both the
atomic-write trailing `\r` and the internal nudge `\r`, leaving
the input buffer parked in `[Pasted text #N +5 lines]` state.

The mid-turn-queue-flush path (`_flushPendingUtterancesImpl`) was
hardened against this exact failure mode in Fix 32 (FIXES.md row 32,
SMOKE Step 3.5 PASS) with an explicit 850ms bare-CR follow-up via
`setTimeout` / `ptyInject(state.bindKey, '\r', false)`. The direct-
inject path was never given the same hardening; it is the only
remaining voice surface in `lex-voice-ws.ts` that injects to a
bound CC PTY without an external follow-up CR.

## 4. Proposed fix scope (no code this round)

1. Direct-inject path at `lex-voice-ws.ts:2147`: after a successful
   primary `ptyInject(state.bindKey, body, true)`, schedule a
   bare-CR follow-up at 850ms (matches `DEFAULT_COMMIT_DELAY_MS` in
   `cross-session-inject.ts:176` and Fix 32's value in
   `_flushPendingUtterancesImpl`) via `setTimeout(() =>
   ptyInject(state.bindKey!, '\r', false), 850)`. `commit=false` so
   `buildPtyInjectPayload` does not append a second `\r` onto the
   bare CR. Wrap in a guard so a teardown between primary and
   follow-up (state.bindKey cleared, socket closed) skips the
   second write.

2. Extract the schedule helper. Fix 32 inlines the 850ms setTimeout
   inside `_flushPendingUtterancesImpl`; the direct-inject path
   needs the same shape. Refactor by hoisting the
   `scheduleFollowupCr` + `_defaultScheduleFollowupCr` test seam
   pair to module scope (they already are in
   `_FlushPendingUtterancesDeps`); the direct-inject path can reuse
   the same defaults so both surfaces stay aligned.

3. Out of scope for this fix: wrapping the body in explicit
   `\x1b[200~...\x1b[201~` bracketed-paste markers in the daemon
   path. That is a longer refactor that would parallel
   `09-bridge/src/bridge-payload.ts` and affects every `ptyInject`
   caller (bridge VSIX, cross-session-inject, seed-first-turn).
   The 850ms bare-CR follow-up is the minimum surgical patch that
   restores parity with Fix 32 on the direct path; the bracketed-
   paste-marker refactor can land as its own investigation if the
   850ms follow-up proves insufficient.

## 5. Regression test pin

New pin in `tests/lex-voice-ws-direct-inject-cr.test.ts` (or
extend the existing `tests/lex-voice-ws-flush-cr.test.ts`).
Contract pinned: when `handleUtteranceEnd` lands on the direct-
inject branch (no mid-turn queue, no contradiction, no command,
no system prompt block), the test seam observes exactly two
`ptyInject` invocations against `state.bindKey`:

1. First call: `(bindKey, body, true)` where body matches the
   composed snapshot/gate/partial/voice/text concatenation.
2. Second call ~850ms later: `(bindKey, '\r', false)`.

When the primary call returns `{ok:false}`, the follow-up MUST
NOT fire (the WS already surfaced the inject error to the
client; double-firing on a known-failed transport just generates
noise). When `state.bindKey` is cleared in the interval (socket
closed, voice disabled), the follow-up MUST NOT fire either.

Mirror the test seam shape from
`_FlushPendingUtterancesDeps.scheduleFollowupCr` so the direct
path is testable without standing up a real ConPTY: inject a
synchronous scheduler that records the delay and lets the test
advance the clock deterministically.

No migration. Rebuild: yes daemon TS only.
