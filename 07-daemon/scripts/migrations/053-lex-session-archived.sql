-- Past Sessions list hide/unhide (2026-07-23). Reversible archive bit
-- on lex_session so the operator can clear stale/test rows out of the
-- /lex "Past sessions" window without hard-deleting the anchor (which
-- cascades transcript-ref pointers and orphans the paired brainstorm
-- row). archived=0 = visible (every existing row; no backfill), 1 =
-- hidden. GET /lex/anchors filters archived rows out; the Delete button
-- on each row flips this bit via POST /lex/anchors/:id/archive. Fully
-- reversible: set archived=0 to restore.

ALTER TABLE lex_session ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
