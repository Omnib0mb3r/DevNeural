/**
 * Session-end pipeline for Lex / brainstorm / voice sessions.
 *
 * One function called from every session-end path (PTY exit, voice
 * "end session" command, voice WS close, notes-mode finalize, plus
 * Wave 2's admin /brainstorms/:id/redistill). Runs an 8-step ordered
 * flush per spec section 11 day 2 step 20 (BF-7). Holds a per-
 * session lock so concurrent funnel paths funnel through one
 * pipeline run; the others await its result.
 *
 * Atomic ordering (each step completes before the next begins):
 *   1. Stop accepting new transcript chunks for this session.
 *      The lock taken at entry is the gate; new caller paths
 *      observe the lock and await rather than racing the writer.
 *      A future fs-watcher coordination flag would tighten this
 *      to disk-flush boundaries; today the in-process lock is the
 *      strongest available guarantee.
 *   2. Drain in-flight transcription jobs from the GPU queue.
 *      No-op until Wave 2 day 1 ships 07-daemon/src/gpu/queue.ts.
 *      The queue's drainSessionId() lands then; the stub here
 *      logs a one-line note so the wire-up is unambiguous.
 *   3. Persist final transcript and update brainstorm_sessions
 *      ended_ms / status='ended'. The pipeline takes ownership
 *      of these fields from the teardown caller; idempotent
 *      because UPDATE is a no-op when the row is already in
 *      that state.
 *   4. Force-flush wiki ingest (existing forceIngestProject).
 *   5. Run Pass 2 against the full transcript via
 *      distillBrainstorm(); produce wiki_drafts rows. Gated on
 *      kind='brainstorm' (BF-15: meetings do NOT auto-distill).
 *      Local LLM only (BF-4: anthropic forbidden for brainstorm
 *      content). Skipped on legacy rows that pre-date the kind
 *      column only when kind is explicitly 'meeting'.
 *   6. Refresh rolling session summary; write to raw_chunks with
 *      kind='brainstorm-summary' (existing).
 *   7. Set distilled_at on the brainstorm_sessions row.
 *   8. Release the session lock (automatic via the lock helper's
 *      finally branch).
 *
 * Each step is best-effort and logs failures rather than throwing
 * so a single step's error does not abort the teardown.
 */
import * as fs from 'node:fs';
import { transcriptsFile } from '../paths.js';
import type { Store } from '../store/index.js';
import { embedOne } from '../embedder/index.js';
import { forceIngestProject } from '../wiki/auto-ingest.js';
import { updateSummary, readSummary } from '../curation/session-summarizer.js';
import { listProjects } from '../identity/registry.js';
import { withSessionEndLock } from './session-end-lock.js';
import { distillBrainstorm } from './brainstorm-distillation.js';
import { gpuQueue } from '../gpu/queue.js';
import {
  finalize as finalizeAudioBundle,
  discard as discardAudioBundle,
} from '../voice/audio-bundle.js';
import { writeThreadDoc } from './thread-doc.js';

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
  /* BF-7 distillation. drafts_created counts wiki_drafts rows
   * inserted; drafts_skipped_reason names the gate that blocked
   * distillation when applicable (kind=meeting, no_provider,
   * bf4_anthropic_blocked, transcript_too_short, llm_validation_failed). */
  drafts_created: number;
  drafts_skipped_reason?: string;
  /* True when this call did the work; false when an earlier
   * concurrent caller already ran and we observed its result via
   * the session-end lock. Helps callers distinguish "nothing
   * changed because already terminated" from "nothing changed
   * because the pipeline really did nothing". */
  was_primary_runner: boolean;
  /* Wave 3 Lane B step 30 (LX-9): thread doc written at session end. */
  thread_doc_written: boolean;
  thread_doc_path?: string;
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
  /* The whole pipeline runs under the per-session lock so concurrent
   * funnel paths (PTY exit + WS close, Stop button + spoken "end
   * session") agree on a single runner. Awaiters get the same result
   * object the primary runner returned and have was_primary_runner
   * set to false. */
  const sessionKey =
    input.claudeSessionId ?? `brainstorm:${input.brainstormId}`;
  let primaryRan = false;
  const result = await withSessionEndLock<SessionEndResult>(sessionKey, async () => {
    primaryRan = true;
    return runOrderedPipeline(store, input, log);
  });
  return { ...result, was_primary_runner: primaryRan };
}

async function runOrderedPipeline(
  store: Store,
  input: SessionEndInput,
  log: (msg: string) => void,
): Promise<SessionEndResult> {
  const out: SessionEndResult = {
    ingest_triggered: false,
    ingest_pages_created: 0,
    ingest_pages_updated: 0,
    summary_written: false,
    summary_embedded: false,
    drafts_created: 0,
    was_primary_runner: true,
    thread_doc_written: false,
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

  /* Step 1 (ordered flush): stop accepting new transcript chunks.
   * The session-end lock is the gate; subsequent caller paths
   * observe the lock and await rather than racing this writer.
   * A future fs-watcher coordination flag would tighten this to
   * disk-flush boundaries; today the in-process lock is the
   * strongest available guarantee. */

  /* Step 2 (ordered flush): drain GPU queue for this session_id.
   * Blocks until no pending or running GPU job carries this
   * session_id. Wired against the singleton GpuQueue initialised
   * at daemon boot (07-daemon/src/daemon.ts). When no jobs were
   * ever submitted with this sessionId, the drain returns
   * immediately. */
  try {
    await gpuQueue().drainSessionId(input.claudeSessionId);
  } catch (err) {
    log(`[session-end] gpu drain failed: ${(err as Error).message}`);
  }

  /* Step 3 (ordered flush): persist the final transcript and update
   * brainstorm_sessions ended_ms / status='ended'. The pipeline
   * takes ownership of these fields; idempotent on repeat calls. */
  try {
    const existing = store.db.getBrainstorm(input.brainstormId);
    if (existing && existing.status !== 'ended') {
      store.db.updateBrainstorm(input.brainstormId, {
        status: 'ended',
        ended_ms: existing.ended_ms ?? Date.now(),
      });
    }
  } catch (err) {
    log(`[session-end] ended_ms update failed: ${(err as Error).message}`);
  }

  /* Step 3a (Wave 2 day 2 / BF-11 / A4): finalise the per-session
   * audio bundle into <id>.wav + <id>.cues.json. Meetings without
   * consent_acked drop their accumulated audio rather than persist it
   * (BF-17 / spec line 281). Brainstorms always persist when audio
   * was captured. Stamps brainstorm_sessions.audio_path so
   * /brainstorms/:id/audio can find the file. */
  try {
    const row = store.db.getBrainstorm(input.brainstormId);
    const isMeeting = (row?.kind ?? 'brainstorm') === 'meeting';
    const consentOk =
      !isMeeting || (row?.consent_acked ?? 0) === 1;
    if (!consentOk) {
      discardAudioBundle(input.brainstormId);
      log(
        `[session-end] audio bundle discarded: meeting without consent_acked (BF-17)`,
      );
    } else {
      const finalised = finalizeAudioBundle(input.brainstormId);
      if (finalised) {
        store.db.setBrainstormAudioPath(input.brainstormId, finalised.audioPath);
        log(
          `[session-end] audio bundle finalised: ${finalised.cueCount} cues, ${finalised.bytes} pcm bytes -> ${finalised.audioPath}`,
        );
      }
    }
  } catch (err) {
    log(`[session-end] audio finalise failed: ${(err as Error).message}`);
  }

  /* Step 4: force-flush wiki ingest. Independent of the periodic loop
   * so an end-of-session that lands between ticks still ships content. */
  try {
    const ingest = await forceIngestProject(store, projectId, log);
    out.ingest_triggered = ingest.ingests_triggered > 0;
    out.ingest_pages_created = ingest.pages_created;
    out.ingest_pages_updated = ingest.pages_updated;
  } catch (err) {
    log(`[session-end] force-ingest failed: ${(err as Error).message}`);
  }

  /* Step 5: BF-7 brainstorm auto-distillation. Only fires for
   * kind='brainstorm' rows; meetings (BF-15) get the meeting-summary
   * artifact via a separate path that does not run here. */
  const kind = store.db.brainstormKind(input.brainstormId);
  if (kind === 'meeting') {
    out.drafts_skipped_reason = 'kind_meeting';
    log(
      `[session-end] distillation skipped: kind=meeting (meetings do not auto-distill, BF-15)`,
    );
  } else {
    try {
      const transcript = recentTranscriptText(
        store,
        projectId,
        input.claudeSessionId,
      );
      const distill = await distillBrainstorm(
        store,
        input.brainstormId,
        transcript,
        log,
      );
      out.drafts_created = distill.drafts_created;
      if (distill.skipped_reason) {
        out.drafts_skipped_reason = distill.skipped_reason;
      }
    } catch (err) {
      log(`[session-end] distillation failed: ${(err as Error).message}`);
      out.drafts_skipped_reason = 'distillation_threw';
    }
  }

  /* Step 6: refresh the rolling session summary one last time so the
   * summarizer captures content from the final turns; embed into
   * raw_chunks tagged kind='brainstorm-summary'. */
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

  /* Step 7: set distilled_at on the brainstorm_sessions row. Marks
   * the row as having been through the full pipeline so /brainstorms
   * can show "distilled" state and admin /redistill can rerun. */
  try {
    store.db.setBrainstormDistilledAt(
      input.brainstormId,
      new Date().toISOString(),
    );
  } catch (err) {
    log(`[session-end] distilled_at update failed: ${(err as Error).message}`);
  }

  /* Step 8: release lock. Handled automatically by withSessionEndLock's
   * finally branch on return. */

  /* Step 9 (Wave 3 Lane B / LX-9): write thread doc pointer file so the
   * next Lex spawn can orient itself on what this session worked on.
   * Best-effort; failures are logged and never block teardown. */
  try {
    const row = store.db.getBrainstorm(input.brainstormId);
    const summaryText = readSummary(input.claudeSessionId!).trim() || null;
    const transcriptText = recentTranscriptText(
      store,
      projectId,
      input.claudeSessionId!,
    ).slice(0, 4000);
    const docResult = await writeThreadDoc(
      {
        brainstormId: input.brainstormId,
        mode: input.mode,
        userLabel: row?.user_label ?? null,
        derivedLabel: row?.derived_label ?? null,
        summaryText,
        transcriptText,
        turnCount: row?.turn_count ?? 0,
        startedMs: row?.started_ms ?? Date.now(),
        endedMs: row?.ended_ms ?? null,
      },
      log,
    );
    out.thread_doc_written = docResult.generated;
    if (docResult.filePath) out.thread_doc_path = docResult.filePath;
    if (docResult.generated) {
      log(`[session-end] thread doc written: ${docResult.filePath} (llm=${docResult.usedLlm})`);
    }
  } catch (err) {
    log(`[session-end] thread doc failed: ${(err as Error).message}`);
  }

  return out;
}

/* Read the full transcript text for a session. Concatenates the
 * recent-chunks loader (already used for the summary refresh) into
 * a single string for the distillation prompt. Cap at 12k chars at
 * the prompt-build site, not here. */
function recentTranscriptText(
  store: Store,
  projectId: string,
  sessionId: string,
): string {
  const chunks = loadSessionChunks(store, projectId, sessionId, 200);
  return chunks
    .map((c) => `${c.role === 'user' ? 'USER' : 'LEX'}: ${c.text}`)
    .join('\n\n');
}
