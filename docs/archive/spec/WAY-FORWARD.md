# Way Forward (post-Wave-3, 2026-05-11)

> **Purpose:** Single source of truth for what comes after Wave 3 lands. Sequenced. Read top to bottom, execute in order.

---

## Where we are

- **Wave 3 is merged to master.** 22 commits ahead of origin. tsc clean both projects, 146 baseline tests pass.
- **No new tests for Wave 3 features.** Code compiles but behaviors are unverified at runtime.
- **Two leftover worktree directories** at `.claude/worktrees/agent-a354fa4e` and `.claude/worktrees/agent-a3547bb5`. Untracked, need cleanup.
- **Step numbering overlap** in `docs/spec/PHASE-TWO-IMPLEMENTATION.md` between Lane A (26-31) and Lane B (30-43, should be 32-45).
- **Lane A deferred** orb search and keyboard navigation. Documented under step 31 TODO.

---

## Step 1: Wave 3 verification pass

Run through every acceptance criterion in `docs/spec/WAVE-3-PLAN.md` with real execution. Report PASS / FAIL / DEFERRED with one-line evidence per item.

Lane A (orb):
- Render orb with 4 node types (brainstorm, wiki, project, meeting), filter chips work
- Double-click opens side panel with connection list and jump links
- Recent-activity glow visible on recently-touched nodes
- Visual idiom matches pre-Wave-3 orb (no regression)

Lane B (Lex):
- Spawn a new brainstorm session, confirm thread doc gets injected into system prompt
- Internal-first retrieval: trigger Lex with "DevNeural" in input, verify the tool gate blocks WebSearch and runs internal retrieval first
- Force the janitor llama job to run, verify it writes audit findings for duplicates/contradictions
- Cross-session injection: from a brainstorm session, fire a prompt into a named worker session, verify it lands and audit log populated
- Curator events appear in live_state output when an audit finding is inserted
- Heartbeat watcher service script starts cleanly or has documented startup
- 3 bug docs in `docs/bugs/` are each resolved or formally deferred to Wave 4

Fixes during verification:
- Any FAIL gets fixed in place with an atomic commit, then re-verified
- Renumber Lane B steps in `docs/spec/PHASE-TWO-IMPLEMENTATION.md` to 32-45 (was 30-43)

Exit criteria for Step 1:
- All acceptance items PASS or formally DEFERRED
- `npx vitest run` 146 green, `npx tsc --noEmit` clean on both projects
- Stop and report. DO NOT proceed to Step 2 without user greenlight.

---

## Step 2: Push and worktree cleanup

After user greenlights verification report:
- `git push origin master`
- `git worktree remove .claude/worktrees/agent-a354fa4e` (and the other)
- Confirm `git worktree list` shows only the primary working tree

---

## Step 3: Execute Wave 4

After push lands clean, execute Wave 4 per `docs/spec/WAVE-4-PLAN.md`. Single-agent recommended for safety. Atomic commits, tests green per commit, stop when scope complete.

Wave 4 scope summary (full detail in WAVE-4-PLAN.md):
- Test coverage for every Wave 3 feature
- Lane A deferred items: orb search + keyboard navigation
- Crossproject_fallback UI panel
- raw_chunks_archived restore endpoint
- Memory budget runaway mitigation
- Permission tier filesystem-level enforcement audit
- Approval fatigue refinement
- Cross-host data root sync spec only

---

## Step 4: Hold for Phase 7

Phase 7 is the next major arc:
- Speaker diarization (pyannote-based)
- Bundled Phase 7 Lex upgrades

Separate planning conversation. Do not start Phase 7 work without an explicit Phase 7 plan doc.

---

## Single invocation prompt

Paste this into a worker session in `C:\dev\Projects\DevNeural` on `master`:

> Read docs/spec/WAY-FORWARD.md and execute Step 1 (Wave 3 verification pass). Atomic commits per fix. Stop and report after Step 1 is clean. Then I will give you greenlight for Step 2 (push) and Step 3 (Wave 4 execution per WAVE-4-PLAN.md). Do not start Step 2 or 3 without my explicit go.
