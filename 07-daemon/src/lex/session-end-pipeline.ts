/**
 * Session-end pipeline for Lex / brainstorm / voice sessions.
 *
 * One function called from every session-end path (PTY exit, voice
 * "end session" command, voice WS close, notes-mode finalize). Runs
 * the existing wiki + RAG infrastructure so brainstorm sessions leave
 * the same durable record as any other Claude Code session, plus a
 * mode-tagged session summary chunk that retrieval can find later.
 *
 * Steps (each is best-effort, failures are logged not thrown so we
 * never block the teardown that called us):
 *   1. forceIngestProject() — flush the project's transcripts.jsonl
 *      tail past its last-ingest cursor through runIngest(). Same
 *      LLM, same Pass-1/Pass-2, same wiki page output as the periodic
 *      auto-ingest loop. The 600-byte minimum is bypassed: small
 *      tail content still goes through; the LLM's own filter decides
 *      whether anything is worth a page.
 *   2. updateSummary() — refresh the rolling session summary at
 *      session-state/<sid>.summary.md. Uses recent raw chunks from
 *      this session_id only (not whole project) so the summary is
 *      session-scoped.
 *   3. Embed the summary text into raw_chunks with metadata
 *      kind='brainstorm-summary' and mode=<voice mode>. The mode
 *      tag is how a meeting recording stays identifiable as such
 *      even after its brainstorm_sessions row is archived. Source-
 *      class lookup at search time still gives it the brainstorm
 *      tier (×0.7) when the row is alive; once archived the chunk
 *      falls back to raw (×0.6) but the mode metadata persists for
 *      filtered queries like "show meeting recordings only".
 *   4. scheduleLint() runs as a side effect of runIngest(); we don't
 *      call it again here.
 *
 * The teardown that called us (voice WS close, PTY exit) handles
 * setting brainstorm_sessions.status='ended' itself; this pipeline
 * does not touch the row.
 */
import * as fs from 'node:fs';
import { transcriptsFile } from '../paths.js';
import type { Store } from '../store/index.js';
import { embedOne } from '../embedder/index.js';
import { forceIngestProject } from '../wiki/auto-ingest.js';
import { updateSummary, readSummary } from '../curation/session-summarizer.js';
import { listProjects } from '../identity/registry.js';

export interface SessionEndInput {
  /** Brainstorm row id, used only for logging; the pipeline does not
   * mutate the row (the caller closes it). */
  brainstormId: string;
  /** Claude Code session uuid. Required: without it we can't look up
   * project_id, can't read transcripts.jsonl tail, can't seed the
   * summarizer. */
  claudeSessionId: string | null;
  /** Voice mode at end-of-session. Used as the durable marker on the
   * embedded summary chunk so future retrieval can filter to
   * 'meeting recordings only' (mode='notes'). */
  mode: 'conversation' | 'notes' | 'push-to-talk' | string;
  /** Reason the session ended; goes into the summary chunk metadata
   * for debuggability ('voice-command' | 'pty-exit' | 'ws-close' | etc). */
  reason: string;
}

export interface SessionEndResult {
  ingest_triggered: boolean;
  ingest_pages_created: number;
  ingest_pages_updated: number;
  summary_written: boolean;
  summary_embedded: boolean;
}

/* Pull last N raw chunks for this session from raw_chunks_meta and
 * pair them with the matching text content from the project's
 * transcripts.jsonl. The watcher writes both in the same flush so
 * file content lines up with the meta rows. We tolerate missing
 * matches (file rotated, partial line) by skipping them. */
function loadSessionChunks(
  store: Store,
  projectId: string,
  sessionId: string,
  limit: number,
): { role: string; text: string; timestamp_ms: number }[] {
  const file = transcriptsFile(projectId);
  if (!fs.existsSync(file)) return [];
  const meta = store.db.recentRawChunksBySession(sessionId, limit);
  if (meta.length === 0) return [];
  /* transcripts.jsonl is append-only: read all of it and filter to
   * matching session_id + role. Cheap because the file is per-project
   * and brainstorm projects stay small. If a project file gets huge
   * later, swap this for a tail-read + jsonl record cap. */
  const raw = fs.readFileSync(file, 'utf-8');
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  const out: { role: string; text: string; timestamp_ms: number }[] = [];
  for (const line of lines) {
    try {
      const rec = JSON.parse(line) as {
        role?: string;
        text?: string;
        session?: string;
        timestamp?: string;
        kind?: string;
      };
      if (rec.session !== sessionId) continue;
      if (rec.role !== 'user' && rec.role !== 'assistant') continue;
      if (rec.kind && rec.kind !== 'text' && rec.kind !== '') continue;
      const text = (rec.text ?? '').trim();
      if (!text) continue;
      const tsMs = rec.timestamp ? Date.parse(rec.timestamp) : Date.now();
      out.push({
        role: rec.role,
        text,
        timestamp_ms: Number.isFinite(tsMs) ? tsMs : Date.now(),
      });
    } catch {
      continue;
    }
  }
  return out.slice(-limit);
}

export async function runSessionEndPipeline(
  store: Store,
  input: SessionEndInput,
  log: (msg: string) => void = () => undefined,
): Promise<SessionEndResult> {
  const out: SessionEndResult = {
    ingest_triggered: false,
    ingest_pages_created: 0,
    ingest_pages_updated: 0,
    summary_written: false,
    summary_embedded: false,
  };
  if (!input.claudeSessionId) {
    log(
      `[session-end] brainstorm=${input.brainstormId} no claude session id; skipping pipeline`,
    );
    return out;
  }
  const projectId = store.db.projectIdBySession(input.claudeSessionId);
  if (!projectId) {
    log(
      `[session-end] brainstorm=${input.brainstormId} session=${input.claudeSessionId} no raw chunks; skipping pipeline`,
    );
    return out;
  }
  const project = listProjects().find((p) => p.id === projectId);
  const projectName = project?.name ?? projectId;

  /* Step 1: force-flush wiki ingest. Independent of the periodic loop
   * so an end-of-session that lands between ticks still ships content. */
  try {
    const ingest = await forceIngestProject(store, projectId, log);
    out.ingest_triggered = ingest.ingests_triggered > 0;
    out.ingest_pages_created = ingest.pages_created;
    out.ingest_pages_updated = ingest.pages_updated;
  } catch (err) {
    log(`[session-end] force-ingest failed: ${(err as Error).message}`);
  }

  /* Step 2: refresh the rolling session summary one last time so the
   * summarizer captures content from the final turns. */
  const recent = loadSessionChunks(store, projectId, input.claudeSessionId, 60);
  if (recent.length >= 2) {
    try {
      const summaryRes = await updateSummary(
        {
          sessionId: input.claudeSessionId,
          projectId,
          projectName,
          newTurns: recent.length,
          recentChunks: recent,
        },
        log,
      );
      out.summary_written = summaryRes.written;
      if (!summaryRes.written) {
        log(`[session-end] summary skipped: ${summaryRes.reason ?? 'unknown'}`);
      }
    } catch (err) {
      log(`[session-end] summary failed: ${(err as Error).message}`);
    }
  } else {
    log(
      `[session-end] only ${recent.length} chunks for session=${input.claudeSessionId}; skipping summary`,
    );
  }

  /* Step 3: embed the latest summary text into raw_chunks tagged as
   * a brainstorm-summary with the session's mode. This is the chunk
   * future retrieval finds when the user asks "what was that meeting
   * about" or "summarise my last brainstorm". */
  const summaryText = readSummary(input.claudeSessionId).trim();
  if (summaryText) {
    try {
      const id = `brainstorm-summary:${input.brainstormId}:${Date.now()}`;
      const vec = await embedOne(summaryText.slice(0, 4000));
      const tsMs = Date.now();
      await store.rawChunks.add({
        id,
        vector: vec,
        metadata: {
          project_id: projectId,
          session_id: input.claudeSessionId,
          timestamp_ms: tsMs,
          kind: 'brainstorm-summary',
          role: 'assistant',
          byte_length: summaryText.length,
          text_preview: summaryText.slice(0, 200),
          /* Durable marker: 'notes' means meeting recording, kept on
           * the chunk metadata even after the brainstorm_sessions row
           * gets archived (the source-class boost goes away then; the
           * mode tag does not). */
          brainstorm_id: input.brainstormId,
          brainstorm_mode: input.mode,
          end_reason: input.reason,
        },
      });
      store.db.upsertRawChunk({
        id,
        project_id: projectId,
        session_id: input.claudeSessionId,
        timestamp_ms: tsMs,
        kind: 'brainstorm-summary',
        role: 'assistant',
        byte_length: summaryText.length,
      });
      out.summary_embedded = true;
      log(
        `[session-end] embedded brainstorm-summary mode=${input.mode} chars=${summaryText.length} project=${projectName}`,
      );
    } catch (err) {
      log(
        `[session-end] embed brainstorm-summary failed: ${(err as Error).message}`,
      );
    }
  }
  return out;
}
