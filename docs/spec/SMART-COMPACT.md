# Context lifecycle: worker auto-clear, handover, and how the layers drive it

Rewritten 2026-09-22 (voice layers wave). Supersedes the 2026-05-11
"Smart compact" spec that this file used to hold; the 60/90 thresholds,
the `/evaluate` + `/fire` endpoints and the "60s scheduler still walks
anchors" description in that version no longer matched the code. The
full map of what exists, with file:line evidence, is
`C:\dev\data\skill-connections\brainstorm\AUTO-CLEAR.md` (sections 0-12
current state, T1-T10 target state). This doc is the short, current
version that reads together with `docs/spec/LAYER-1-CONTROL.md`.

The operator's description of the target flow (2026-09-21): Lex sees
the worker's context filling, tells the worker to come to a stopping
point and write a handover, reviews that handover against what Lex
knows they are doing and working on and the overall status, makes any
needed changes, then clears the worker's context and injects the
reviewed, concise handover.

---

## 1. What exists today (built, wired, on)

Code name **smart-clear** (the trigger, "Layer B") running on the
**smart-compact** transport ("Layer A"). It is context-triggered and
Lex-executed: the daemon detects and reports, Lex (L2) polls and pulls
the trigger, the worker is purely reactive.

| Step | Who | Where |
|---|---|---|
| Worker jsonl grows, daemon derives `ctx_pct` | daemon | `07-daemon/src/dashboard/sessions.ts` `deriveContextFromTail` |
| Verdict `idle` / `wind-down` (>= 40%) / `force-stop` (>= 60%) | daemon, pure | `07-daemon/src/lex/smart-clear.ts` `evaluateSmartClearTrigger`; `GET /lex/smart-clear/state` |
| Plan: safe stopping point + vetted reseed draft | daemon | `POST /lex/smart-clear/plan` (`draftStoppingPoint`, `draftReseed`, `vetReseed`) |
| Drive the worker to the stop (commit-first if dirty, never mid-edit) | Lex (L2) | `POST /lex/inject-cross-session` with `caller_label` `smart-clear` / `smart-compact:*` |
| `/clear` + paste the reseed as a user turn | daemon | `POST /lex/smart-compact/clear-and-paste` (`clearAndPaste`, `awaitNewSessionReady` 45s); gated by `smart_compact_mode === 'live'` |
| SessionStart hook re-injects a handoff doc | worker hook | `POST /worker/clear-handoff` (`buildWorkerHandoff`) |
| Confirm the reseed landed and an assistant reply followed | daemon | `POST /lex/smart-clear/confirm` (`confirmResumeOnTask`) |
| Audit row per attempt | daemon | `smart_compact_log` (`caller`, `reason`, `action`, `pre_ctx_pct`, `summary_preview`, `payload_text`) |

Two mode keys still coexist (a known footgun, AUTO-CLEAR section 10):
`smart_compact_mode` (the real inject gate, dashboard toggle, default
`shadow`) and `smart_clear_mode` (the advisory trigger, no UI, default
`off`). Both must be `live` for the loop to run. Verified live on
2026-07-20: both `live`, threshold 40, ceiling 60.

Nothing periodic: the loop fires off `[supervisor-event]` markers that
the worker's own jsonl activity produces (chokidar listener). The one
timer that stays is the 60s stall watch for a worker that goes dark.

---

## 2. Who drives it, after the voice layers wave

- **L2 (the brain) drives.** The driver contract
  (`renderSupervisionDrive()` in `07-daemon/src/lex/system-prompt.ts`)
  renders only for a scoped mid spawn bound to a worker. The 2026-07-18
  regression stranded it because L2 was spawned on demand; since the
  voice layers wave, Open on a brainstorm spawns L1 and then L2
  immediately, scoped to its worker, so the driver loop is always on
  the always-live L2. AUTO-CLEAR section 3 root cause 2 is closed by
  construction.
- **L1 (the voice) never drives.** It has no tools and cannot poll a
  state endpoint. It only narrates: its `[live]` block shows L2 in a
  tool or thinking, and it can tell the operator "she is clearing the
  worker's context, about a minute" when asked or when it matters.
- **The dispatch confirm gate exempts context management.** With
  `dispatch_confirm_gate=on`, Lex's worker dispatches are parked for a
  spoken yes, EXCEPT callers whose `caller_label` is `smart-clear`,
  `smart-compact:*`, `event-supervisor` or `auto-supervisor`
  (`isContextManagementCaller` in `07-daemon/src/lex/dispatch-gate.ts`).
  The auto-clear worker drive is context management, not new work; the
  carve-out stays that narrow (AUTO-CLEAR T10.2). The prompt rule
  "confirm before dispatching new work" is unchanged.

---

## 3. Target state (AUTO-CLEAR T3, the operator's flow)

Continuity lives in a durable, checked handover document, not in an AI
guess and not in the session being cleared. The one who did the work
writes the handover; the one who holds the plan approves it and adds
the forward direction.

1. **Watch.** Event-driven off the worker's own turn-end `ctx_pct`. Trip
   at the threshold (40%), force at the ceiling (60%).
2. **Gate.** Check the auto-clear switch.
3. **Author.** The worker writes its OWN handover into the frame
   (section 4): verified state, what it was doing, decisions in force,
   stopping point. It knows this best and only ever sees its slice of
   the plan.
4. **Structural vet.** Slots filled, not a transcript dump, sane
   (cheap, before Lex looks).
5. **Review and append.** Lex compares the handover to the overarching
   plan and the overall status, corrects what drifted, and appends the
   next steps the worker cannot see.
6. **Drive to stop.** Lex tells the worker to reach a safe stop
   (commit-first if dirty, never mid-edit). Exempt from the dispatch
   gate (section 2).
7. **Clear.** The worker `/clear`s; its SessionStart hook re-injects the
   approved handover as the reseed.
8. **Confirm.** Trail the new jsonl for resume-on-task.

Reseed depth tracks state depth: worker tight, Lex rich, voice zero
(L1 clears to its bare system prompt; LAYER-1-CONTROL.md "Context
hygiene").

### 4. The handover frame (T5)

| Slot | Author |
|---|---|
| Verified state (git HEAD, tree clean or dirty, in-flight files) | Worker |
| What I was doing (task + position, e.g. "end of step 3") | Worker |
| Next steps (step 4+ from the plan) | Lex (appended) |
| Decisions in force (constraints carrying forward) | Either |
| Stopping point (safe-stop confirmation) | Worker or Lex |
| Plan reference (which plan, which section) | Lex |

Freeform prose inside each slot, adaptive depth: write until a fresh
agent resumes with zero gaps. Carry acute state in full; reference
durable state (plan, prior handovers, docs) instead of copying it.
The current reseed already carries a loose version of this frame
(`Resume: / Verified state / Were doing / Next / Decisions / Stopping
point`); the rework formalizes it and splits authorship.

---

## 5. Phase C (BUILT in the 2026-09-22 evening wave): what turns section 1 into section 3

Operator additions folded in on 2026-09-22: every handover is
timestamped and browsable on the brainstorm page; a handover is also
written at every session end and recovered from the jsonl trail after a
crash (marked unvetted); the file shows the worker's draft and Lex's
review as separate, labelled halves with author and time; Lex previews
the handover by voice before the clear; the context gauge on every
session surface shows the trip and force marks the trigger reads; and
Lex checks current state before speaking any of it. Recipe, in build
order:

1. `POST /lex/smart-clear/handover-request`: the daemon injects a wrap
   prompt asking the worker to write its handover into the frame and
   reply `ready` (exempt caller label `smart-clear`).
2. `POST /lex/smart-clear/review`: Lex posts the worker's handover plus
   its own Next steps and edits; the daemon runs `vetReseed`, persists
   the approved handover under
   `<DATA_ROOT>/brainstorms/<anchor>/HANDOVER-<iso>.md` (reuse
   `07-daemon/src/lex/handover-writer.ts` `writeHandover`), and returns
   the reseed text.
3. `clear-and-paste` takes a `handover_id` and pastes the approved
   handover; `/worker/clear-handoff` returns the same approved handover
   instead of recomputing one (kills the double reseed).
4. Merge `smart_clear_mode` and `smart_compact_mode` into one
   `auto_clear_mode` with a single dashboard switch.
5. Lex self-clear (T4): `writeHandover` on the stop pipeline, a
   `POST /lex/clear-handoff` that serves `findLatestHandover`, and
   `postLexClearHandoff` in the `clear` / `compact` branch of the
   SessionStart hook (today the Lex preload fires only on `startup`);
   a secondary agent approves; never clear Lex and the worker in the
   same instant.
6. Archive, do not delete: keep the recent N handovers in full, roll
   older ones into a meta-handover.
7. Session end and crash (T6, operator 2026-09-22): every terminal end
   path writes a handover next to distillation (T10.1 keeps the roles
   distinct); the boot crash sweep writes one from the jsonl tail with
   the worker slots filled and a "recovered from the trail, unvetted"
   banner.
8. Visible vetting (T5): the persisted file renders "Worker draft"
   (author session, time, the slots as submitted) then "Lex review"
   (corrections one per line, appended Next steps, verdict, time).
9. Browse: `GET /lex/anchors/:id/handovers` lists them newest first;
   `GET /lex/anchors/:id/handovers/:file` serves one; the brainstorm
   page shows the list.
10. Voice preview: `[handover-ready]` to L1, `approve_handover` /
    `reject_handover <reason>` (LAYER-1-CONTROL.md v3).
11. Gauge: `/lex/anchor-tiles` and `/sessions` carry `ctx_pct` for the
    worker and for Lex with the threshold and ceiling; the dashboard
    draws the bar with both marks on the deck, the Lex tab and the
    sessions table.

Scope rule that must hold (AUTO-CLEAR T10.1): the handover replaces
distillation ONLY as the resume seed. Brainstorm distillation stays as
the knowledge, orb and recall layer.

---

## 6. Restart-verify for the restored driver loop

With a worker at `ctx_pct >= 40` under a brainstorm that supervises it,
`smart_clear_mode=live` and `smart_compact_mode=live`:

1. A `[supervisor-event]` lands in L2 (worker commit, idle, test
   failure).
2. L2 polls `GET /lex/smart-clear/state` and gets `wind-down`.
3. L2 calls `plan`, drives the worker to a stop, then
   `clear-and-paste`, then `confirm`.
4. `smart_compact_log` gains a row with `caller:'smart-clear'` and
   reason `ctx-fill-plan` then `ctx-fill-confirm-ok`.
5. With the dispatch gate armed, none of L2's smart-clear injects are
   parked (the `daemon.log` shows no `[dispatch-gate] parked` line for
   them); a genuine work dispatch from the same L2 is parked.
