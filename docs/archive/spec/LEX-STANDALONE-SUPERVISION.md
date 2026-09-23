# Lex standalone supervision spec

Sister spec to `PLAN-brainstorm-without-cc.md`. That plan made the brainstorm a durable entity that outlives CC sessions. This spec defines what Lex DOES during the gaps: between voice turns, between worker attaches, across his own restarts.

**Companion spec:** `docs/spec/LEX-AUTONOMY-PAYLOAD-SPEC.md`. That spec defines WHAT context gets assembled and delivered on Lex cold-start and worker boot. This spec's idle-watcher passes (T+5/20/60min, T+6h day-cap) are the WRITE-PATH that feeds the payload spec's READ-PATH. Concretely: this spec refreshes `last_summary`, writes `brainstorm_chunks` rollups (kind='arc-rollup'), and emits HANDOVER artifacts; the payload spec consumes those exact artifacts when Lex or a worker boots. Read both together.

**Gating:** Stages 5-12 of the payload spec are the formal "Lex autonomy" milestone, gated behind the Stage 0-2 smoke test (see `TODO.md` "Next after Stage 0-2 smoke"). This supervision spec's idle-watcher must be producing fresh inputs for at least one full day-cycle before autonomy stages ship.

## Core principle

Lex (the standalone brainstorm session) is the smartest node and the canonical state owner. Workers come and go; Lex persists across them. Every behavior in this spec exists to preserve Lex's continuity across his own cycle AND across worker cycles.

If Lex restarts blind, or a fresh worker attaches and finds stale context, the system has failed.

## Lifecycle states (existing, from PLAN-brainstorm-without-cc)

`brainstorm_sessions.lifecycle_state`:
- `idle` — alive but not currently in a voice turn; no worker attached OR worker present but quiet
- `attached` — bound to a CC worker session that's actively running
- `speaking` — mid voice turn (user talking, Lex generating, or Lex speaking)
- `ended` — session closed, distillation complete

This spec adds behavior rules per state, plus a new idle-watcher timer.

## Idle-watcher

A daemon-side timer runs per `lifecycle_state='idle'` brainstorm row. Fires grooming passes at escalating intervals from the last user utterance.

| Trigger | Action |
|---|---|
| T+5min silence | Light pass: write `brainstorm_chunks` rollup for any unflushed turns; update `last_summary` if more than 10 new turns since last write. |
| T+20min silence | Mid pass: distill open arcs, mark decisions parked, refresh thread-doc, prune dead branches. Same payload as detach-distillation today. |
| T+60min silence | Cold pass: write full handover artifact (`brainstorms/<id>/HANDOVER-<timestamp>.md`) with active arcs, parked decisions, planted markers, recent-turn excerpt. This is what a fresh Lex preload will read first. |
| T+6h silence OR 06:00 local | Day-cap: same as cold pass, plus mark `lifecycle_state='ended'` and trigger final distillation + sibling-index update. |

Timer resets to T+0 on every user utterance.

## Grooming actions (run during passes)

1. **Distill open arcs.** Identify conversational threads still in progress (no decision, no parked marker). Write a one-paragraph summary per arc into `brainstorm_chunks` with `kind='arc-rollup'`.
2. **Promote parked decisions.** Any `parked` marker older than 24h surfaces as a candidate for the morning brief.
3. **Refresh `last_summary`.** Overwrite `brainstorm_sessions.last_summary` so cold-start preload reflects current state, not last-detach state.
4. **Refresh thread-doc.** Same write path used by today's session-end pipeline; this spec extends it to run mid-session.
5. **Prune dead branches.** Mark chunks `superseded=true` when a later turn explicitly reversed or replaced them.

## Escalation triggers (push to user)

Lex pings the user (dashboard alert + optional voice) only when:

1. **Parked decision aged past 48h** AND it blocks a worker queue.
2. **Open arc cold past 6h** AND it was flagged as a critical-path arc.
3. **Worker handover ready** at 06:00 local (morning brief).
4. **Distillation or grooming pass FAILED** twice in a row (system health).

Standing alerts are silent. The user's existing rule applies: cron-driven ticks emit zero chat text; escalations go via voice or dashboard alert, never buried in transcript.

## Behavior per state

| State | Lex behavior between turns |
|---|---|
| `idle` (no worker) | Idle-watcher runs. Grooming on cadence. No worker injection. |
| `idle` (worker attached, worker quiet) | Idle-watcher runs. Grooming on cadence. Standard worker-supervision cron also runs in parallel. |
| `attached` (worker active) | Worker-supervision protocol takes precedence. Idle-watcher pauses; grooming deferred to next idle window. |
| `speaking` | All grooming paused. User turn is sacred. |
| `ended` | Final distillation runs. No further grooming. |

## Continuity contract

When ANY of the following happen, the next consumer (Lex or worker) MUST find fresh context:

- Lex restart → cold-start preload pulls `last_summary` + latest HANDOVER doc + recent turns. Already shipped; this spec ensures `last_summary` is mid-session-fresh, not detach-stale.
- Worker attach to existing brainstorm → worker SessionStart preamble pulls the same payload. Already shipped via worker SessionStart preload; ensure it reads the freshest grooming artifact, not just last-detach.
- Worker cycle (worker /clear, /compact, or restart) → re-runs SessionStart preload. No change needed if preload reads freshest grooming artifact.

The grooming cadence above is the mechanism that keeps "freshest" fresh.

## Implementation pointers

### Schema additions

- `brainstorm_sessions.last_grooming_pass_at` (TEXT ISO timestamp, nullable).
- `brainstorm_sessions.last_grooming_kind` (TEXT: `light`, `mid`, `cold`, `day-cap`, nullable).
- `brainstorm_sessions.last_user_utterance_at` (TEXT ISO timestamp; resets on every user turn).

### New files

- `07-daemon/src/lex/idle-watcher.ts` — timer loop, reads all `lifecycle_state='idle'` rows, fires grooming when thresholds hit.
- `07-daemon/src/lex/grooming.ts` — pass implementations (light / mid / cold / day-cap).
- `07-daemon/src/lex/handover-writer.ts` — writes `brainstorms/<id>/HANDOVER-<timestamp>.md`.

### Changes to existing

- `07-daemon/src/voice/lex-voice-ws.ts` — on every user turn, update `last_user_utterance_at`, set `lifecycle_state='speaking'`, then back to `idle` on turn end.
- `07-daemon/src/lex/session-end-pipeline.ts` — refactor distillation so the same code path serves cold pass + day-cap + end-session.
- `07-daemon/src/lex/cold-start-preload.ts` — read `last_grooming_pass_at` and prefer the HANDOVER doc if it's newer than `last_summary`.

### Dashboard surface

- New panel: "Standalone brainstorm idle activity" — shows each idle brainstorm row with last user utterance time, last grooming pass kind/time, count of parked decisions, count of cold arcs.
- Escalation alerts route to the existing dashboard system-alert area; no new alert UI needed.

## Out of scope (for now)

- Cross-brainstorm grooming (threading multiple brainstorms together) — covered by `project_devneural_brainstorm_threads` memory; address later.
- Curator integration into idle activity — handled separately via `project_devneural_curator_in_livestate`.
- Worker permission widening during idle — orthogonal; covered by worker-supervision protocol.

## Open questions (escalate to user before implementing)

1. Should the day-cap handover wake the user via push, or only appear on next dashboard open? Default proposal: dashboard only unless parked decisions cross the 48h threshold.
2. Should idle-watcher run for `runtime_mode='cc-pty'` legacy brainstorms, or only `runtime_mode='direct-llm'`? Default proposal: both, since the artifacts are schema-driven, not runtime-driven.
3. Voice mode while idle: should Lex spontaneously speak if a grooming pass surfaces something interesting, or stay silent until spoken to? Default proposal: stay silent. Spontaneous speech violates the "silent tick" rule.
