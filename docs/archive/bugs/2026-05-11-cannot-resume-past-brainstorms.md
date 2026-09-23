# Cannot resume past brainstorm sessions (resume action grayed out)

**Status:** open
**Date opened:** 2026-05-11
**Severity:** medium

---

## Symptoms

User cannot switch to a previous brainstorm session and continue it. The resume action on past sessions appears grayed out / disabled in the brainstorm picker UI.

## Reproduction

1. Open `/brainstorms` page
2. Locate a past (ended) brainstorm session
3. Attempt to click resume / switch into it
4. Observe: resume action is grayed out, no way to continue the session

## Expected

User should be able to pick any past brainstorm session and resume it as the active conversation, with full prior context loaded.

## Impact

- Brainstorm threading (a Wave 3 design goal) requires session resumption as the substrate
- Without resume, every brainstorm is a one-shot with no way to continue prior work
- Defeats the thread-doc handoff Wave 3 just shipped, since handoff assumes you can re-enter the same brainstorm

## Suspected location

- Brainstorm picker UI in `08-dashboard/src/brainstorms/` or wherever the BrainstormList lives
- The resume action handler / button enable state logic
- Possibly the daemon side too: is there a `POST /brainstorms/:id/resume` endpoint? If not, that's the missing piece

## Related

- `2026-05-10-brainstorm-picker-and-transcripts.md` covers different issues on the same page (empty list, missing transcripts), not the resume action

## Status

Fixed (pending soak) — 2026-05-11, Wave 3 fixup sprint.

## Root cause

The resume button in `08-dashboard/components/LexSessionList.tsx` was
gated on `disabled={resumeM.isPending || Boolean(activePtyId)}`. The
`/lex` page auto-spawns a fresh Lex on mount, so `activePtyId` is
effectively always truthy whenever the user can see the resume
buttons. The tooltip ("End the current Lex session before resuming
a past one") explained the gate but provided no in-row way to act on
it.

## Fixes shipped

- `LexSessionList.tsx`: drop the `activePtyId` part of the disabled
  check. The resume mutation now does the same kill-then-spawn dance
  as the page-level "new session" button (`ptyKill` + patch the old
  brainstorm row to `status: 'ended'` + 400ms gap so Windows
  taskkill /F /T tree unwind completes before the new spawn).
- The button label switches to "switch to" when an active PTY exists,
  signalling that the action will end the current session first.
- Tooltip rewritten to mention both the resume target and the
  switch-from semantics; preserves the existing
  `claude_session_id`-vs-fresh-PTY distinction.

## Verification

Manual:
1. Open `/lex`, observe auto-spawned Lex.
2. Open `/brainstorms`, locate a past session.
3. Click resume / switch to.
4. Observe: active Lex ends, new PTY spawns with `--resume <session_id>`
   when the row had a `claude_session_id`, or in the same cwd with the
   carried label when it did not.

`tsc --noEmit` clean on `08-dashboard`.
