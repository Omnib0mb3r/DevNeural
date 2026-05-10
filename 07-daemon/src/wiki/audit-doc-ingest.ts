/**
 * Wave 2 day 3 step 14 (A6). Periodic ingest of audit documents
 * (`voice-review.md` plus `docs/audit/*.md`) as synthetic brainstorm
 * sessions so future Lex recall can surface them. Per spec section 11
 * day 3 step 14:
 *
 *   - mode='notes', kind='brainstorm' (explicit override of the
 *     default `notes -> meeting` BF-14 rule; audit docs are written
 *     reflection on the system itself, not third-party speech).
 *   - provenance='audit-document'
 *   - project_slug=NULL, audio_path=NULL, consent_acked=0
 *   - Chunked into brainstorm_chunks; each line/heading boundary
 *     becomes one row.
 *
 * Idempotent: re-runs use a stable id derived from the file path so
 * a re-ingest only updates the chunk text rather than appending
 * duplicates. The `/meetings` route filters out provenance=
 * 'audit-document' (BF-15 mirror) and BF-7 distillation gates on
 * provenance='voice', so synthetic rows never trigger meeting-class
 * privacy treatment or auto-distillation.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { Store } from '../store/index.js';
import { getModelId } from '../embedder/index.js';

export interface AuditIngestResult {
  files_scanned: number;
  files_ingested: number;
  chunks_written: number;
  errors: string[];
}

interface AuditTarget {
  absPath: string;
  /** Stable id (`audit-<sha1-12>`) used as both brainstorm_sessions.id
   * and the prefix for brainstorm_chunks ids so re-runs replace
   * rather than duplicate. */
  brainstormId: string;
  /** Display label shown on /brainstorms detail. */
  label: string;
}

function makeBrainstormId(absPath: string): string {
  const h = createHash('sha1').update(absPath).digest('hex').slice(0, 12);
  return `audit-${h}`;
}

function discoverTargets(repoRoot: string): AuditTarget[] {
  const targets: AuditTarget[] = [];
  const voiceReview = path.posix.join(repoRoot, 'voice-review.md');
  if (fs.existsSync(voiceReview)) {
    targets.push({
      absPath: voiceReview,
      brainstormId: makeBrainstormId(voiceReview),
      label: 'voice-review.md',
    });
  }
  const auditDir = path.posix.join(repoRoot, 'docs', 'audit');
  if (fs.existsSync(auditDir) && fs.statSync(auditDir).isDirectory()) {
    for (const name of fs.readdirSync(auditDir)) {
      if (!name.endsWith('.md')) continue;
      const abs = path.posix.join(auditDir, name);
      targets.push({
        absPath: abs,
        brainstormId: makeBrainstormId(abs),
        label: `docs/audit/${name}`,
      });
    }
  }
  return targets;
}

/* Split markdown into chunk-shaped pieces. Heading boundaries (any
 * level) start a new chunk; otherwise paragraphs separated by a
 * blank line. Skips empty pieces. */
function chunkMarkdown(raw: string): string[] {
  const out: string[] = [];
  const blocks = raw.split(/\n\s*\n/);
  for (const blk of blocks) {
    const trimmed = blk.trim();
    if (!trimmed) continue;
    /* Cap individual chunk size so a giant code block does not
     * dominate the token budget downstream; 1.5k chars matches the
     * raw_chunks default. */
    if (trimmed.length <= 1500) {
      out.push(trimmed);
      continue;
    }
    for (let i = 0; i < trimmed.length; i += 1500) {
      out.push(trimmed.slice(i, i + 1500));
    }
  }
  return out;
}

export async function runAuditDocIngest(
  store: Store,
  repoRoot: string,
  log: (m: string) => void = () => undefined,
): Promise<AuditIngestResult> {
  const out: AuditIngestResult = {
    files_scanned: 0,
    files_ingested: 0,
    chunks_written: 0,
    errors: [],
  };
  const targets = discoverTargets(repoRoot);
  out.files_scanned = targets.length;
  if (targets.length === 0) {
    log(`[audit-doc-ingest] no audit docs found under ${repoRoot}`);
    return out;
  }
  const modelId = getModelId();
  for (const t of targets) {
    try {
      const raw = fs.readFileSync(t.absPath, 'utf-8');
      const chunks = chunkMarkdown(raw);
      if (chunks.length === 0) continue;
      const nowMs = Date.now();
      /* Synthetic brainstorm_sessions row. INSERT OR REPLACE keeps
       * idempotency; the additive Phase Two columns (kind,
       * provenance, consent_acked, project_slug, audio_path) get
       * patched via updateBrainstorm so the row is never silently
       * downgraded on re-run. */
      store.db.insertBrainstorm({
        id: t.brainstormId,
        claude_session_id: null,
        pty_id: null,
        cwd: repoRoot,
        user_label: t.label,
        derived_label: null,
        mode: 'notes',
        status: 'ended',
        started_ms: nowMs,
        ended_ms: nowMs,
        turn_count: chunks.length,
        topic_tags_json: '[]',
        artifacts_json: '{}',
        last_summary: chunks[0] ?? null,
        last_summary_ms: nowMs,
      });
      store.db.setBrainstormPhaseTwo(t.brainstormId, {
        kind: 'brainstorm',
        provenance: 'audit-document',
        project_slug: null,
        audio_path: null,
        consent_acked: 0,
      });
      for (let i = 0; i < chunks.length; i++) {
        store.db.insertBrainstormChunk({
          id: `${t.brainstormId}-c${i}`,
          brainstorm_id: t.brainstormId,
          turn_index: i,
          role: 'user',
          mode: 'notes',
          text: chunks[i] ?? '',
          model_id: modelId,
        });
      }
      out.files_ingested += 1;
      out.chunks_written += chunks.length;
      log(
        `[audit-doc-ingest] ${t.label} -> brainstorm ${t.brainstormId} (${chunks.length} chunks)`,
      );
    } catch (err) {
      out.errors.push(`${t.label}: ${(err as Error).message}`);
    }
  }
  return out;
}
