# Smoke Test Handover — Paste-Ready Resume

**STATUS 2026-05-26 04:18 EDT:** Smoke steps 3.1 through 3.7 all PASS. Step 4 PASS via natural Lex CC repoint churn. Remaining: Step 5 (voice mic-init, needs mobile Safari + operator), Step 6 (FIXES.md flips + greenlight). Active overnight work has moved to Fix 41 (smart-compact policy refactor). See `docs/OVERNIGHT-2026-05-26.md` for current state.

The resume prompt below is from the 03:10 EDT snapshot, retained for historical context. Skip to the current overnight doc for live cursor.

---

**RESUME PROMPT (copy verbatim to fresh Lex, 2026-05-26 03:10 EDT snapshot — HISTORICAL):**

> Pick up from 2026-05-26 overnight session. Smoke gate already closed: 3.1-3.6 PASS live, 3.7 PASSED THEN REGRESSED (Fix 34d routed supervisor payloads to worker instead of Lex — caught by operator 02:30 EDT). Read docs/SMOKE-PROGRESS.md for live cursor. Read docs/SMOKE-HANDOVER.md "Overnight state" below.
>
> Active commits NOT YET activated (daemon still pid 196004 uptime 4000s+, NOT restarted yet):
> - 318260f fix(supervisor): route Lex injects through pty + extract high-signal snippet (Fix 34d.1)
> - c2bff48 docs(fixes): record Fix 34d.1 row
>
> In-flight in worker queue (committed and/or pending):
> - Fix 34d.2 false-shipment detector (narrated-success-no-commit event type)
> - Coalesce utterance queue (single-stream invariant, classify queued items, one structured reply)
> - LEX-AUTONOMY-PAYLOAD-SPEC Stages 5-12 (codex order, distillation query scope first)
> - Docs sweep + dashboard grooming
> - Remove skip-permissions for workers
> - New project + brainstorm isolation test
>
> Cron 5c231dd7 ticks every 2 min, silent supervision; will keep injecting until 7am.
>
> Once operator clicks dashboard restart-daemon button (NOTE: button copy lies — restart actually takes minutes, not seconds; queued fix on TODO):
> 1. Wait ~5 min for daemon to come back; /health should report new pid + uptime under 60s
> 2. Re-run smoke step 3.7 with new criteria: event-supervisor row must appear in Lex CC jsonl (2a708d6d in C:/Users/michael/.claude/projects/C--dev-data-skill-connections-brainstorm/) NOT worker jsonl, with delivery_mode=lex-pty (not lex-queue)
> 3. If 3.7 passes clean, flip SMOKE-PROGRESS.md step 3.7 from REGRESSED back to PASS and update FIXES.md row 34d.1 to smoke-verified

## Overnight state (2026-05-26 03:10 EDT)

- Worker session: 94e85826-6b30-45d1-88e0-0d94c44650b9 (post /clear repoint from 837dd156)
- Lex CC session: 2a708d6d-44db-4668-97f5-bce3e94d19b0
- Anchor: 391b88f6-396c-4c46-a8d7-b656a2d5ad1d (DevNeural, supervision_mode=event)
- Daemon: pid 196004, started ~05:55 UTC, NOT restarted post 34d.1 ship (intentional — finishing more work in code first, then one big restart)
- Cron: job id 5c231dd7, recurring every 2 min, silent unless escalation

## What shipped tonight (commits)

- 318260f Fix 34d.1: route supervisor injects through Lex pty (not bridge-prompt), drop with rejected-not-lex when no active Lex CC; high-signal snippet picker (filter CC meta, per-event payload formatter)
- c2bff48 FIXES.md row for 34d.1
- Earlier in session: 34, 34b, 34c (supervisor wire stack), 32 (mid-turn CR), 33 (cancelled-tool recovery), 27 (vad-error ring buffer), 28 (jsonl repoint drain), 29 (hold-up resume), 30 (late-jsonl bind offset), 31 (first-turn TTS)

## Known gotchas

- Dashboard restart-daemon button copy says "seconds" but actually takes minutes; operator workaround: hit button, wait 5 min, verify /health pid changed
- Curator/reinforcement injection has never been observed firing on workers; either cosine threshold too high or pipeline broken. Add validation task before next round.
- Supervisor wire reads `getLexTranscriptRefByCc` to decide Lex vs worker; if multiple lex_transcript_ref rows for same anchor are unended, Fix 34c reverse-walk picks newest open. Should be self-healing.

## Bounce-state context (2026-05-26T00:30Z)

Voice end_session matcher is fully functional. Pipeline runs to completion on the prior attempt: brainstorm_sessions.status='ended' at 1779752499839 (23:41:39 UTC), TTS killed, but `lex_transcript_ref.ref_summary` stayed NULL and dashboard tile never flipped.

Root cause: for Lex direct-llm brainstorms `projectIdBySession` returns null so the pipeline falls into `runBrainstormChunksFallback` (session-end-pipeline.ts:277). That fallback only wrote `brainstorm_sessions.last_summary` via `createLlmDistillationGenerator`. It NEVER wrote `lex_transcript_ref.ref_summary` and never recomputed the rolling aggregate. Step 7a in the main ordered pipeline is the only writer for those fields, and direct-llm rows never reach it.

**Shipped fix — commit `862d42a` (2026-05-25 20:22 EDT):**

- `07-daemon/src/lex/session-end-pipeline.ts` — port Step 7a chain into `runBrainstormChunksFallback` after the existing LLM `last_summary` write, before `setBrainstormDistilledAt`. Same `getLexTranscriptRefByCc` -> `countBrainstormChunksForSession` -> `createPerSessionDistillationGenerator` -> `updateLexTranscriptRef` -> `recomputeRollingAggregate` chain. Gated on `input.claudeSessionId` so the truly direct-llm case logs a structured skip rather than crashing.
- Dashboard SSE broadcast emit for `brainstorm-ended` on the status flip (both fallback and main pipeline). Dashboard tile re-fetches brainstorm list on receipt.

Daemon + dashboard builds green at commit time. Restart of daemon required before any re-run.

**Resume action for step 3.1 (after daemon restart):**

1. User clicks dashboard restart-daemon button.
2. Wait ~10s for `/health` to return new pid.
3. User opens fresh brainstorm OR re-uses the existing `4bbafb48` anchor.
4. User speaks "Lex end session" OR clicks dashboard End button.
5. Tail `C:/dev/data/skill-connections/daemon.stdout.log` for `[chunks-fallback] ref_summary written` line.
6. Run 3.2 query: `SELECT ref_summary, ref_summary_ms FROM lex_transcript_ref WHERE cc_session_id='<the cc id of the session you just ended>';` Expect non-null `ref_summary`, `ref_summary_ms > 0`.
7. Run 3.3 query: `SELECT last_summary FROM brainstorm_sessions WHERE id='<anchor>';` Expect rolling aggregate text reflecting the just-ended session.
8. Run 3.4 cold-start verification — start fresh brainstorm same anchor, preload header should show differentiated sibling summaries.
9. Verify dashboard tile flips to ended within ~2s of pipeline completion (no manual refresh needed).

**Carry-over from prior attempt:** the existing `4bbafb48-bbfd-47e6-b076-e1a58a334303` row is already status='ended' with NULL ref_summary. Acceptable to leave NULL on that one and validate against a freshly-ended session, OR run a one-shot pipeline call to backfill (not required to close 3.1).

**New post-restart probes (run after Step 3.1-3.4 passes):**

- **3.5 Fix 32 mid-turn CR.** In an active voice brainstorm, speak a second utterance while Lex is still mid-reply (forces the mid-turn queue). When Lex finishes the in-flight reply, the queued utterance must auto-submit at the next turn boundary — no manual Enter from the user. If the cursor sits after `[voice mode]` without submitting, the fix regressed.
- **3.6 Fix 33 cancelled-tool-recovery.** Force a tool-result reject in a Lex session (easiest: send a chat message while Lex is mid-tool, which yields the "Request interrupted by user" envelope). Within ~5 s a row should land in `cross_session_injection_log` with `caller_label='lex-cancelled-tool-recovery'`, and Lex's next assistant turn should resume on its own without further user input. Two consecutive cancellations within 30 s should produce a `decision='shadow'` row with `reject_reason='recovery_exhausted: ...'` and a dashboard banner via the `t:'recovery-exhausted'` WS frame.
- **3.7 Fix 34 supervisor wire.** After daemon restart, `curl http://localhost:3747/dashboard/health-supervisor` should return `health:'ok'` once the worker emits any watched event (commit, idle past threshold, permission denial, etc.). The same event should produce a new row in `cross_session_injection_log` with `caller_label='event-supervisor'`. Pre-fix the supervisor wrote zero rows even with `supervision_mode='event'` set, so any single row counts as the wire delivering.

---

## What the smoke is verifying

- **Stage 0:** `cc_session_id` stamps on new brainstorm_chunks rows; legacy NULLs preserved.
- **Stage 1:** Lex assistant turns write chunks regardless of worker attachment.
- **Stage 2:** Per-session distillation writes `lex_transcript_ref.ref_summary` + refreshes anchor `last_summary`; cold-start shows differentiated sibling summaries.
- **Repoint fix (Fix 28, e16fe0e):** Old jsonl drained on `/clear`; new session starts fresh.
- **Voice mic-init fix (f237673):** vad-error lands in diagnostics ring buffer, not just UI toast.

## Gate

All Steps 1-5 green -> flip FIXES.md rows 27 + 28 to smoke-verified -> greenlight LEX-AUTONOMY Stages 5-12.

## Known carry-overs (do not block smoke)

- Double-talk on stacked utterances. Coalesce fix queued post-smoke, ahead of autonomy.

## Files in the smoke loop

- `docs/SMOKE-TEST.md` — full checklist, source of truth for which steps are done (`[x]` vs `[ ]`).
- `docs/SMOKE-PROGRESS.md` — rolling cursor with last completed step + active step + evidence.
- `docs/SMOKE-HANDOVER.md` — this file. Paste-ready resume prompt.
- `docs/spec/LEX-AUTONOMY-PAYLOAD-SPEC.md` — the spec being smoke-gated.
- `TODO.md` — post-smoke queue (coalesce first, then autonomy stages).
