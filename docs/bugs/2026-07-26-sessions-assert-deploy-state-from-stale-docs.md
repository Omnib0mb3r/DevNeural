# Sessions assert deploy / "fixed-in-prod" state from stale docs instead of checking live state

**Status:** open — scheduled into the cold-start / smart-compact layer build
**Date:** 2026-07-26
**Severity:** medium (wastes time; chases wrong root causes; erodes trust)

## Symptom

A session (Lex, or a worker) states as fact something like "that fix is
deployed / the running daemon has it / that predates the daemon" by reading a
handover note, bug doc, or memory, WITHOUT checking the live process. This
session did it: claimed 925eecb (typed-transcript fix) was live off a
2026-07-19 handover line. Live check proved the opposite: daemon PID 3932 has
run since 2026-07-24 on stale dist; `dist` was only rebuilt with 925eecb today
(2026-07-26 14:38). restart != rebuild.

## Root cause

Docs/handover/bug-tracker/memory are treated as current truth. They reflect
what was true when written. There is no pushed signal that tells a session how
far the running daemon is behind HEAD, so nothing forces a live check before a
deploy-state claim.

## Fix (build with the cold-start layers)

Fold into the cold-start / smart-compact layers (`docs/spec/SMART-COMPACT.md`,
which already extends `live_state`). Add a `live_state` **deploy-delta** line,
injected every session:

- running daemon PID + start time,
- newest compiled `dist` mtime,
- git HEAD + commits-behind-HEAD count (and dist-behind-HEAD).

So every session is handed "daemon started 7/24, dist rebuilt 7/26, running
code is N commits behind" without asking, and cannot parrot a stale doc past
it. Backup behavioral rule saved as memory `feedback_verify_live_deploy_state`:
verify deploy/live/fixed-in-prod against the live process + dist mtime + git
HEAD + actual behavior before asserting; docs are hypotheses, never proof.

## Open items

- [ ] Implement the `live_state` deploy-delta as part of the cold-start layer build.
- [ ] Until then, manually check process start vs dist mtime vs git HEAD before any deploy claim.
