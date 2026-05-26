-- LEX-AUTONOMY codex item 6 (Fix 43): distillation_error_log.
--
-- Captures the structured failure paths inside
-- createPerSessionDistillationGenerator (and createLlmDistillationGenerator)
-- so the dashboard + the staleness watcher can surface why a ref
-- summary went / stayed NULL beyond the threshold. Generic enough to
-- accept anchor-flat + per-session writers via the same row shape;
-- error_class is the structured tag (no_provider, bf4_blocked,
-- provider_threw, empty_reply, no_scoped_chunks, validation_failed,
-- timeout) and error_message is the verbatim Error.message text when
-- available.
--
-- Append-only; no UPDATE / DELETE paths. Retention strategy deferred
-- to codex 7 (which will likely fold this into the same retention
-- sweep that prunes cross_session_injection_log).

CREATE TABLE IF NOT EXISTS distillation_error_log (
  id              TEXT PRIMARY KEY,
  ts              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  brainstorm_id   TEXT,
  cc_session_id   TEXT,
  generator       TEXT NOT NULL,
  error_class     TEXT NOT NULL,
  error_message   TEXT,
  detail          TEXT
);

CREATE INDEX IF NOT EXISTS ix_distillation_error_ts
  ON distillation_error_log(ts DESC);
CREATE INDEX IF NOT EXISTS ix_distillation_error_anchor_ts
  ON distillation_error_log(brainstorm_id, ts DESC);
CREATE INDEX IF NOT EXISTS ix_distillation_error_class_ts
  ON distillation_error_log(error_class, ts DESC);
