-- Brainstorm-as-durable-primary-entity (2026-05-22, Path B).
--
-- See docs/PLAN-brainstorm-without-cc.md. The brainstorm row becomes
-- the durable Lex brain that outlives any CC session attached to it.
-- Existing rows assume a Lex CC PTY backs every brainstorm (the
-- pty-host.ts:spawnLex path); the new direct-llm runtime mode lets a
-- brainstorm exist standalone with the voice WS calling the LLM
-- provider directly.
--
-- Columns added:
--   runtime_mode             how this brainstorm's Lex is implemented
--     'cc-pty'      legacy: Lex is a Claude Code PTY spawned by
--                   pty-host.ts:spawnLex; voice injects through it.
--     'direct-llm'  new:    Lex is a daemon-side LLM call via
--                   pickProvider().call(); no Lex CC PTY exists.
--     'detached'    transitional state when the brainstorm is alive
--                   but no runtime is bound (rare; mostly for
--                   testability).
--
--   lifecycle_state          current lifecycle of the brainstorm,
--                            independent of any PTY existence
--     'idle'        row exists, no voice WS, no worker attached
--     'attached'    a worker CC is bound (separate from the brainstorm
--                   itself), no voice in flight
--     'speaking'    voice utterance in flight (mic open or TTS)
--     'ended'       session-end-pipeline ran; archived
--
--   attached_worker_session_id  CC session UUID of the worker
--                               currently bound to this brainstorm
--                               (distinct from claude_session_id,
--                               which is the LEGACY Lex CC PTY in
--                               cc-pty mode). Null in cc-pty mode and
--                               when no worker is attached. Set by
--                               attachWorkerSession()/cleared by
--                               detach.
--
-- Defaults: existing rows backfill to runtime_mode='cc-pty' (legacy
-- behavior) and lifecycle_state derived from current `status`
-- ('active' -> 'idle' so the new path treats them as ready to attach;
-- 'ended' -> 'ended'). pty_id is already nullable in the original
-- schema (no NOT NULL constraint) so no ALTER needed there.

ALTER TABLE brainstorm_sessions ADD COLUMN runtime_mode TEXT NOT NULL DEFAULT 'cc-pty';

ALTER TABLE brainstorm_sessions ADD COLUMN lifecycle_state TEXT NOT NULL DEFAULT 'idle';

ALTER TABLE brainstorm_sessions ADD COLUMN attached_worker_session_id TEXT;

-- Backfill lifecycle_state for legacy rows. Active brainstorms with a
-- pty_id are mid-conversation (treat as idle so the next voice turn
-- can take them through speaking and back). Ended ones stay ended.
UPDATE brainstorm_sessions
   SET lifecycle_state = CASE
                           WHEN status = 'ended' THEN 'ended'
                           ELSE 'idle'
                         END;

CREATE INDEX IF NOT EXISTS idx_brainstorm_runtime_mode
  ON brainstorm_sessions (runtime_mode);

CREATE INDEX IF NOT EXISTS idx_brainstorm_lifecycle_state
  ON brainstorm_sessions (lifecycle_state);

CREATE INDEX IF NOT EXISTS idx_brainstorm_attached_worker
  ON brainstorm_sessions (attached_worker_session_id);
