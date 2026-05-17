/**
 * Reference doc processing pipeline.
 *
 * Receives an uploaded file (already on disk under reference/queue/),
 * extracts text via the right extractor, chunks, embeds, stores into
 * reference_chunks Chroma collection, and updates SQLite metadata.
 *
 * Audio + video extraction is queued for Phase 3.5 (whisper.cpp +
 * ffmpeg). DOCX is supported via mammoth. Plain text and markdown
 * are direct.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  referenceDocsDir,
  referenceImagesDir,
  referenceAudioDir,
  referenceVideoDir,
  ensureDir,
} from '../paths.js';
import { embedOne } from '../embedder/index.js';
import { chunkText, type Chunk } from './chunk.js';
import { extractPdf } from './pdf.js';
import { extractImage } from './image.js';
import { extractAudioTranscript } from './audio.js';
import { extractVideoTranscript } from './video.js';
import { emitNotification } from '../dashboard/notifications.js';
import {
  ReferenceStore,
  detectKind,
  type ReferenceDocMeta,
  ensureReferenceDirs,
} from './store.js';

export interface UploadInput {
  filename: string;
  buffer: Buffer;
  project_id?: string;
  tags?: string[];
}

export interface UploadResult {
  ok: boolean;
  doc_id?: string;
  status: ReferenceDocMeta['status'];
  warnings: string[];
  error?: string;
  chunk_count?: number;
  char_count?: number;
}

export async function ingestUpload(
  store: ReferenceStore,
  input: UploadInput,
  log: (msg: string) => void = () => undefined,
): Promise<UploadResult> {
  ensureReferenceDirs();
  const docId = randomUUID();
  const kind = detectKind(input.filename);
  const projectId = input.project_id ?? 'global';

  // Write file to its kind-specific dir
  const targetDir =
    kind === 'image'
      ? referenceImagesDir()
      : kind === 'audio'
        ? referenceAudioDir()
        : kind === 'video'
          ? referenceVideoDir()
          : referenceDocsDir();
  ensureDir(targetDir);
  const docFolder = path.posix.join(targetDir, docId);
  ensureDir(docFolder);
  const safeName = sanitizeFilename(input.filename);
  const originalPath = path.posix.join(docFolder, safeName);
  fs.writeFileSync(originalPath, input.buffer);

  // Record meta as queued
  const baseMeta: ReferenceDocMeta = {
    doc_id: docId,
    filename: input.filename,
    kind,
    project_id: projectId,
    tags: input.tags ?? [],
    upload_ts: new Date().toISOString(),
    char_count: 0,
    chunk_count: 0,
    status: 'queued',
  };
  store.upsertDoc(baseMeta);

  // Extract text
  store.upsertDoc({ ...baseMeta, status: 'processing' });
  let text = '';
  let pageCount: number | undefined;
  const warnings: string[] = [];

  try {
    if (kind === 'pdf') {
      const r = await extractPdf(originalPath, log);
      text = r.text;
      pageCount = r.page_count;
      warnings.push(...r.warnings);
    } else if (kind === 'image') {
      const r = await extractImage(originalPath);
      text = r.text;
      warnings.push(...r.warnings);
    } else if (kind === 'markdown') {
      text = fs.readFileSync(originalPath, 'utf-8');
    } else if (kind === 'docx') {
      const mammoth = (await import('mammoth')) as unknown as {
        extractRawText: (input: { path: string }) => Promise<{ value: string }>;
      };
      const r = await mammoth.extractRawText({ path: originalPath });
      text = r.value;
    } else if (kind === 'audio') {
      const r = await extractAudioTranscript(originalPath);
      if (r.ok) {
        text = r.text;
      } else if (r.reason === 'no_whisper') {
        return handleMissingBinary(
          store,
          baseMeta,
          'whisper.cpp',
          r.detail ?? 'whisper.cpp not installed',
          warnings,
          log,
        );
      } else {
        warnings.push(`audio transcription failed: ${r.detail ?? 'unknown'}`);
      }
    } else if (kind === 'video') {
      const r = await extractVideoTranscript(originalPath);
      if (r.ok) {
        text = r.text;
      } else if (r.reason === 'no_ffmpeg') {
        return handleMissingBinary(
          store,
          baseMeta,
          'ffmpeg',
          r.detail ?? 'ffmpeg not installed',
          warnings,
          log,
        );
      } else if (r.reason === 'no_whisper') {
        return handleMissingBinary(
          store,
          baseMeta,
          'whisper.cpp',
          r.detail ?? 'whisper.cpp not installed',
          warnings,
          log,
        );
      } else {
        warnings.push(`video transcription failed: ${r.detail ?? 'unknown'}`);
      }
    } else {
      // Plain text / unknown: try to read as utf-8
      try {
        text = fs.readFileSync(originalPath, 'utf-8');
      } catch {
        text = '';
      }
    }
  } catch (err) {
    const msg = (err as Error).message;
    store.upsertDoc({
      ...baseMeta,
      status: 'failed',
      error: msg,
      warnings,
    });
    log(`[reference] extract failed for ${input.filename}: ${msg}`);
    return { ok: false, doc_id: docId, status: 'failed', warnings, error: msg };
  }

  if (!text || text.trim().length < 20) {
    store.upsertDoc({
      ...baseMeta,
      ...(pageCount !== undefined ? { page_count: pageCount } : {}),
      char_count: text.length,
      status: 'failed',
      error: 'no text extracted',
      warnings: [...warnings, 'no usable text extracted from file'],
    });
    return {
      ok: false,
      doc_id: docId,
      status: 'failed',
      warnings,
      error: 'no text extracted',
    };
  }

  // Persist extracted text alongside the original
  fs.writeFileSync(path.posix.join(docFolder, 'text.md'), text, 'utf-8');

  // Chunk + embed + store
  const chunks: Chunk[] = chunkText(text);
  const chunksFile = path.posix.join(docFolder, 'chunks.jsonl');
  fs.writeFileSync(chunksFile, '', 'utf-8'); // truncate

  for (const chunk of chunks) {
    try {
      const vec = await embedOne(chunk.text);
      const id = `${docId}:${chunk.index}`;
      await store.chunks.add({
        id,
        vector: vec,
        metadata: {
          doc_id: docId,
          kind,
          project_id: projectId,
          chunk_index: chunk.index,
          text_preview: chunk.text.slice(0, 200),
          upload_ts_ms: Date.parse(baseMeta.upload_ts),
        },
      });
      fs.appendFileSync(
        chunksFile,
        JSON.stringify({
          id,
          chunk_index: chunk.index,
          start_offset: chunk.start_offset,
          end_offset: chunk.end_offset,
          text: chunk.text,
        }) + '\n',
        'utf-8',
      );
    } catch (err) {
      warnings.push(`chunk ${chunk.index} embed failed: ${(err as Error).message}`);
    }
  }
  await store.flush();

  // FTS index over the full text
  store.ftsIndex(docId, input.filename, text);

  const finalMeta: ReferenceDocMeta = {
    ...baseMeta,
    ...(pageCount !== undefined ? { page_count: pageCount } : {}),
    char_count: text.length,
    chunk_count: chunks.length,
    status: 'done',
    warnings: warnings.length > 0 ? warnings : [],
  };
  store.upsertDoc(finalMeta);
  log(
    `[reference] ${input.filename}: ${chunks.length} chunks embedded, ${text.length} chars`,
  );

  return {
    ok: true,
    doc_id: docId,
    status: 'done',
    warnings,
    chunk_count: chunks.length,
    char_count: text.length,
  };
}

function sanitizeFilename(name: string): string {
  return name.replace(/[<>:"|?*\x00-\x1F]/g, '_').slice(0, 200);
}

/**
 * Audio/video uploads should not fail just because the user has not
 * yet installed whisper.cpp or ffmpeg. We park them with status
 * 'queued' (re-processable) and a clear notification.
 */
function handleMissingBinary(
  store: ReferenceStore,
  baseMeta: ReferenceDocMeta,
  binary: 'whisper.cpp' | 'ffmpeg',
  detail: string,
  warnings: string[],
  log: (msg: string) => void,
): UploadResult {
  const note = `processing_pending: ${binary} not installed. ${detail}`;
  store.upsertDoc({
    ...baseMeta,
    status: 'queued',
    warnings: [...warnings, note],
  });
  emitNotification({
    severity: 'warn',
    source: 'reference-ingest',
    notify_class: 'signal',
    title: `Audio/video processing requires ${binary}`,
    body: detail,
  });
  log(`[reference] ${baseMeta.filename}: deferred (${binary} missing)`);
  return {
    ok: true,
    doc_id: baseMeta.doc_id,
    status: 'queued',
    warnings: [...warnings, note],
  };
}
