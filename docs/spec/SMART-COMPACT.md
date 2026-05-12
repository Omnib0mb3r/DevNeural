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

Lex builds the resume prompt from durable sources, NOT from its own context:

1. Latest spec doc referenced in the session (`docs/spec/*.md` modified or read
   recently per the worker's jsonl tool log).
2. Top of the relevant section of `TODO.md`.
3. `git log --oneline -10` and `git diff --stat` against the branch.
4. Recent `project_transcript_ref` tail (last ~2k tokens of worker jsonl).
5. Open audit findings / curator alerts for the project (via existing
   `audit_findings` query).

Composed into a single prompt of the shape:

```
You were working on <project>. Context refreshed for capacity.

Active work: <one sentence from spec + TODO>.
Recent commits:
  <commit list>
Uncommitted: <diff stat>
Last action: <jsonl tail summary>

Resume from where you left off. Full transcript is at <jsonl_path> if you need
to look anything up.
```

---

## Mechanics

### Inject path

Reuse `POST /lex/inject-cross-session`. New `caller_label` prefix
`smart-compact:<reason>` for audit trail (`window-open`, `forced-no-stop`,
`hard-ceiling`).

### Clear-then-refresh

CC's `/clear` slash command followed by the resume prompt. Both pasted in
sequence via the same inject call (or two calls with a small gap if `/clear`
needs to settle).

### Ctx percent source

Comes from the live_state assembly — daemon already tracks `% ctx` per session
(visible in live_state today). Smart compact reads from the same place. No new
instrumentation.

### Audit

New table or column on `cross_session_injection_log` to flag smart-compact
attempts with their reason + pre/post ctx_pct. Dashboard panel surfaces a
timeline so user can see the auto-compactions.

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
