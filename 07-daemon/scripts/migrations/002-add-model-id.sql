-- EM-1: Embedder model_id on every chunk row.
--
-- Backfill uses the configured embedder id at migration time. The
-- placeholder string '__BACKFILL_PENDING__' is overwritten by the
-- daemon's first boot after this migration applies (see
-- src/db/backfill-model-id.ts, which runs after the legacy IndexDb
-- migrate() pass and reads the configured embedder id from settings).
--
-- Only raw_chunks_meta exists today; reference chunks live in a
-- separate DB. A follow-up migration will mirror this column over to
-- the reference store once that store also adopts the migration
-- runner.

ALTER TABLE raw_chunks_meta ADD COLUMN model_id TEXT;

UPDATE raw_chunks_meta
SET model_id = '__BACKFILL_PENDING__'
WHERE model_id IS NULL;
