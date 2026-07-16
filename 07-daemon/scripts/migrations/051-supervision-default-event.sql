-- Supervision default flips to 'event' (operator directive 2026-07-16).
--
-- The seed-project-anchors backfill (and the original migration's
-- column default) stamped every anchor with an EXPLICIT 'polling'
-- supervision_mode. Explicit values win over the runtime default, so
-- flipping default_supervision_mode to 'event' in runtime_config
-- never touched them: 31 of 35 anchors on the live box still sat on
-- polling with the operator flipping them by hand one at a time.
--
-- Those rows are seed artifacts, not operator choices - the operator
-- has only ever set 'event' (or fixed a stray 'polling') by hand.
-- One-time backfill: polling -> event. 'off' rows are untouched (the
-- kill-switch IS an operator choice), and anything set after this
-- migration is an explicit choice the default never overrides.
UPDATE project_session
   SET supervision_mode = 'event'
 WHERE supervision_mode = 'polling';
