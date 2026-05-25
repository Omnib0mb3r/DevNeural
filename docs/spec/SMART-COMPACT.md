# Spec: Smart compact — Lex-driven worker context refresh

**Created:** 2026-05-11 (brainstorm session "DevNeural Testing")
**Status:** Ready to plan/implement.
**Depends on:** `PROJECT-ANCHORS.md` (live_state must expose worker session id + ctx %).

---

## Goal

Lex automatically refreshes a worker session's context before drift sets in,
without losing in-flight state. Smarter than blind `/compact`: triggered on a
configurable threshold window AND gated by natural stopping points, with a
durable summary assembled from spec / TODO / git rather than from Lex's own
(also-drifting) context.

---

## Trigger logic

Two conditions, both required:

1. **Window open:** worker `ctx_pct` ∈ `[THRESHOLD - 5, THRESHOLD + 5]`.
   - Default `THRESHOLD = 60` (env `DEVNEURAL_SMART_COMPACT_THRESHOLD_PCT`).
   - Per-anchor override stored on `project_session` row (future, defer to v2).
2. **Stop point reached:** any of:
   - Worker emits a commit in the last 30s.
   - Worker is idle (no tool call in last 30s).
   - Worker phase = `idle` or `awaiting-prompt` per `/lex/anchor-tiles` feed.

Both true → fire compact.

### Override: forced refresh

If window closes (ctx_pct > THRESHOLD + 5) without ever hitting a stop point,
Lex injects a wrap-and-commit prompt to manufacture a stop:

```
Wrap your current work: commit what's stable with a meaningful message, defer
the rest with a TODO comment if needed. Reply "ready" when done. Reason:
context refresh in progress.
```

Wait for the worker's "ready" or a commit, then compact.

Hard ceiling fallback: if ctx_pct > 90 with no resolution, compact anyway and
flag the anchor with `last_forced_compact_ms` for the dashboard.

---

## Summary assembly

**v2:** Lex composes the resume prompt from its live conversation
context, not from durable artifacts. See "Mechanics -> v2 - Lex-authored
resume prompt" below for the rationale. The v1 artifact-driven recipe
preserved here for history:

> v1 (deprecated): Lex builds the resume prompt from durable sources,
> NOT from its own context: (1) latest spec doc referenced, (2) top of
> the relevant TODO section, (3) `git log --oneline -10` plus
> `git diff --stat`, (4) recent jsonl tail, (5) open audit findings.
> Composed into a single prompt with sections for active work, commits,
> uncommitted diff, last action, transcript pointer. Observed failure
> mode: stale fragments rendered as Goal / Current state with no
> coherent Next step. Replaced by Lex-authored prose in v2.

---

## Mechanics

### v2 - Lex-authored resume prompt

The daemon does NOT build the resume summary. Lex composes the prompt at
fire time using its live conversation context (active todos, files just
read/edited, the user's last directive, the deviation that triggered the
refresh) and posts it as `summary` on `POST /lex/smart-compact/fire`. The
daemon validates non-empty, persists the audit row, and ships /clear plus
the supplied summary to the worker. That is the entire transport contract.

Rationale: v1 built the summary from durable artifacts (TODO heading +
jsonl tail + git status). In practice those sources lag the live thought
of the worker by minutes and frequently pull stale or unrelated fragments
into "Goal" and "Current state" sections. The result was a resume prompt
the worker could not act on; recent observed failures included a parked
menu rendering with no Next step. Lex already holds the only canonical
view of where the worker actually is, so Lex authors.

The legacy six-section builder lives on in
`07-daemon/src/lex/six-section-resume.ts` as an optional caller-side
helper. Lex MAY call it when the live context is too thin to compose
prose, but the default path is hand-written prompt -> POST fire.

### Endpoint contract

```
POST /lex/smart-compact/evaluate   {anchor_id, ctx_pct?, phase?}
  -> {action: 'fire' | 'wrap' | 'wait',
      reason, ctx_pct, shadow, jsonl_path, anchor_id}
     (no `summary` field; daemon does not build one)

POST /lex/smart-compact/fire       {anchor_id, reason, action,
                                    summary, caller?, ctx_pct?, force?}
  -> 400 if action='fire' and summary missing/empty/whitespace-only
  -> writes audit row + injects /clear then summary on the bound PTY
  -> action='wrap' uses daemon-authored WRAP_AND_COMMIT_PROMPT and
     does NOT take a caller `summary`
```

### Scheduler

The 60s daemon tick (`runSmartCompactTick`) still walks live anchors and
calls evaluate. action='wrap' fires through the daemon as before
(WRAP_AND_COMMIT_PROMPT is daemon-authored). action='fire' is deferred to
Lex - the scheduler logs `fire-deferred-to-lex` and skips. Lex's own poll
loop picks up the same evaluate verdict, authors the summary in context,
and calls fire.

### Inject path

Reuse `POST /lex/inject-cross-session`. New `caller_label` prefix
`smart-compact:<reason>` for audit trail (`window-open`, `forced-no-stop`,
`hard-ceiling`).

### Clear-then-refresh

CC's `/clear` slash command followed by the resume prompt. Two injects
gated by `awaitNewSessionReady` so the summary lands after CC's new-
session attachment chain finishes (otherwise the auto-CR fires during
init and the summary parks in the input box).

### Ctx percent source

Comes from the live_state assembly - daemon already tracks `% ctx` per
session (visible in live_state today). Smart compact reads from the same
place. No new instrumentation.

### Audit

`smart_compact_log` table records every attempt with reason, pre_ctx_pct,
summary_preview (caller-supplied), and full payload_text. Dashboard panel
surfaces a timeline so the operator can see the auto-compactions.

---

## Safety nets

- Full jsonl always retrievable. Summary doesn't have to be lossless.
- User can disable per-anchor or globally (env + UI toggle).
- Forced refresh is loud: dashboard banner + voice alert when it fires
  outside the normal window.
- First N refreshes per anchor are "shadow mode": Lex builds the summary,
  writes it to the audit log, but does NOT inject. User compares against
  what they'd expect before flipping to live mode.

---

## Constraints / decisions

- Default threshold: **60 percent**, plus/minus 5.
- Two-condition trigger: window AND stop point. Not OR.
- Lex orchestrates, daemon executes. No new daemon-side scheduler thread.
- Resume prompt sources are durable artifacts, not Lex's own memory.
- /clear + resume in one logical operation.
- Shadow mode first per new anchor.
- Hard ceiling 90 percent forces compact regardless of stop point.

---

## Open questions (defer to plan)

- Voice alert behaviour when refresh fires while user is talking to Lex.
- Interaction with the deferred Wave 3 step 32 thread-doc handoff (LX-9): the
  thread doc may be a better summary source than building one ad-hoc each
  time. Possibly subsume smart compact into the thread-doc machinery.
- Per-anchor cadence cap so a misbehaving worker doesn't trigger 10 compacts
  in 10 minutes.
