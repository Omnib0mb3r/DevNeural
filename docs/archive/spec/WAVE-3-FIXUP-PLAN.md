# Wave 3 Fixup: Bug Sweep

> **Origin:** Brainstorm "Dev brainstorm season" decision on 2026-05-11. Wave 3 shipped, but the open bug log accumulated faster than wave scope absorbed it. This is a focused, between-waves bug-fix sprint. Runs before Wave 4 execution.
>
> **Precondition:** Wave 3 push complete (origin/master at `255e20f` or later).

---

## Scope

Fix all currently-open dashboard / voice / state-tracker bugs in the bug log. Pull forward the items previously deferred to Wave 4. After this sprint, the bug index should have zero open dashboard bugs.

### In scope

| Bug doc | Severity | Notes |
|---------|----------|-------|
| `2026-05-11-push-to-talk-not-releasing-mic.md` | medium | Voice client PTT mode does not stop mic on release |
| `2026-05-11-cannot-resume-past-brainstorms.md` | medium | Resume action grayed out on past brainstorm sessions |
| `2026-05-11-dashboard-small-screen-overflow.md` | medium | Header overflows on narrow viewports |
| `2026-05-10-brainstorm-picker-and-transcripts.md` | medium | Pulled forward from Wave 4 deferral |
| `2026-05-10-state-tracker-loses-live-sessions.md` | medium | Pulled forward from Wave 4 deferral |
| `2026-05-10-cc-feedback-prompt-unanswerable.md` | medium | Verify whether Wave 3 Lane B step 42 actually fixed this; if not, fix now |
| `2026-05-05-leftover-session-tiles.md` | low | Status is "Fixed (pending soak)" — confirm soak window passed; close if green, else investigate residual |

### Out of scope

- Wave 4 scope (test coverage, orb search, Lex hardening) — defer until this sprint ends.
- Any new bugs discovered mid-sprint that aren't already in the index — log them but do not fix unless they're a blocker for the in-scope fixes.

---

## Execution rules

- **Root cause first.** No workarounds unless an experienced engineer would agree it's the only option.
- **Atomic commits per bug.** Commit message format: `fix(<area>): <one-line> (bug: YYYY-MM-DD-slug)`.
- **Update the bug doc** in the same commit as the fix: set status to "fixed (pending soak)", add a "Fixes shipped" section with the commit SHA, add a "Verification" note describing what was exercised.
- **Update `docs/bugs/README.md`** index after each fix.
- **Tests where reasonable.** If the bug has a unit-testable seam, add a regression test. If purely UI, manual verification note is acceptable.
- **tsc clean per commit.** Both daemon and dashboard.
- **Stop and report when scope is complete.** Do NOT proceed into Wave 4.

---

## Post-fixup housekeeping

After all in-scope bugs are closed:

1. Update `docs/spec/WAVE-4-PLAN.md`: remove the brainstorm-picker, state-tracker, and any other items that landed in this sprint. Note the removal in a small changelog block at the top.
2. Push origin/master.

---

## Acceptance criteria

- Every in-scope bug doc shows status "fixed (pending soak)" or "closed".
- `docs/bugs/README.md` open-bugs table has zero rows from the in-scope list.
- tsc clean both projects.
- Tests pass; test count went up if any unit-testable seams were exercised.
- WAVE-4-PLAN.md no longer references items that were handled here.

---

## Invocation

> Read docs/spec/WAVE-3-FIXUP-PLAN.md and execute. Single agent, atomic commits per bug, stop and report when scope is complete. Do NOT proceed into Wave 4.
