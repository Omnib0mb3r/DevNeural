-- BF-3: Full brainstorm transcripts as first-class searchable rows.
--
-- Mirrors the raw_chunks_meta shape but with a no_decay flag and a
-- direct FK to brainstorm_sessions. The session-end pipeline writes
-- one brainstorm-summary row to raw_chunks_meta (legacy behaviour)
-- AND N brainstorm_chunks rows for the full transcript (new).
--
-- Vector embeddings live in the existing vector store keyed by id;
-- this table holds the metadata side only, matching the raw_chunks
-- pattern in index-db.ts.

CREATE TABLE IF NOT EXISTS brainstorm_chunks (
  id            TEXT PRIMARY KEY,
  brainstorm_id TEXT NOT NULL,
  turn_index    INTEGER NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('user','lex','tool')),
  mode          TEXT NOT NULL CHECK (mode IN ('conversation','notes','push-to-talk')),
  text          TEXT NOT NULL,
  model_id      TEXT NOT NULL,
  no_decay      INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (brainstorm_id) REFERENCES brainstorm_sessions(id)
);

CREATE INDEX IF NOT EXISTS brainstorm_chunks_session
  ON brainstorm_chunks(brainstorm_id, turn_index);

CREATE INDEX IF NOT EXISTS brainstorm_chunks_mode
  ON brainstorm_chunks(mode);
