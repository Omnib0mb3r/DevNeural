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

Open. Belongs in Wave 4 scope, important for brainstorm threading story.
