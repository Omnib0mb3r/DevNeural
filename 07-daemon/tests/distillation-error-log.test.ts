/**
 * LEX-AUTONOMY codex item 6 (Fix 43) - distillation_error_log pins.
 *
 * Migration 042 + insertDistillationError + listRecentDistillationErrors
 * + write-through from createPerSessionDistillationGenerator on every
 * structured null-return path.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IndexDb } from '../src/store/index-db.js';
import { runMigrations } from '../src/db/migrate.js';
import { createPerSessionDistillationGenerator } from '../src/lex/distillation-generator.js';
import type { LlmProvider } from '../src/llm/index.js';

function stubProvider(
  name: string,
  call: LlmProvider['call'],
): LlmProvider {
  return {
    name,
    description: 'test stub',
    isConfigured: () => true,
    configHint: () => '',
    call,
    modelIds: () => ({
      ingest: '',
      lint: '',
      reconcile: '',
      selfQuery: '',
      distillation: '',
    }),
  };
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');

let tmpDir: string;
let db: IndexDb;
const ANCHOR_ID = 'brainstorm-err-log';
const CC_ID = '00000000-0000-0000-0000-000000000ccc';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-distill-err-'));
  const dbFile = path.join(tmpDir, 'index.db');
  const seed = new IndexDb(dbFile);
  seed.close();
  await runMigrations({ dbPath: dbFile, migrationsDir: MIGRATIONS_DIR });
  db = new IndexDb(dbFile);
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* ignore */
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function seedAnchor(): void {
  db.insertBrainstorm({
    id: ANCHOR_ID,
    claude_session_id: CC_ID,
    pty_id: null,
    cwd: 'C:/dev/codex6-err',
    user_label: 'codex6-err',
    derived_label: null,
    mode: 'conversation',
    status: 'active',
    started_ms: 1,
    ended_ms: null,
    turn_count: 0,
    topic_tags_json: '[]',
    artifacts_json: '{}',
    last_summary: null,
    last_summary_ms: null,
  } as unknown as Parameters<typeof db.insertBrainstorm>[0]);
  db.insertLexSession({
    id: ANCHOR_ID,
    created_ms: 1,
    title: null,
    derived_title: null,
    status: 'live',
    current_pty_id: null,
    cwd: 'C:/dev/codex6-err',
  });
}

describe('distillation_error_log helpers (Fix 43)', () => {
  it('insertDistillationError + listRecentDistillationErrors round-trip', () => {
    db.insertDistillationError({
      id: 'e1',
      brainstorm_id: 'b-1',
      cc_session_id: 'cc-1',
      generator: 'per-session',
      error_class: 'provider_threw',
      error_message: 'connection refused',
    });
    db.insertDistillationError({
      id: 'e2',
      brainstorm_id: 'b-2',
      cc_session_id: 'cc-2',
      generator: 'per-session',
      error_class: 'empty_llm_reply',
    });
    const all = db.listRecentDistillationErrors(20);
    expect(all.length).toBe(2);
    /* DESC by ts; e2 was inserted last so it should be first. */
    expect(all[0]!.id).toBe('e2');
    expect(all[1]!.id).toBe('e1');
    const onlyB1 = db.listRecentDistillationErrors(20, { brainstormId: 'b-1' });
    expect(onlyB1.length).toBe(1);
    expect(onlyB1[0]!.error_class).toBe('provider_threw');
    expect(onlyB1[0]!.error_message).toBe('connection refused');
  });
});

describe('createPerSessionDistillationGenerator writes structured errors (Fix 43)', () => {
  it('writes error_class=bf4_anthropic_blocked when provider is anthropic', async () => {
    seedAnchor();
    const fakeProvider = stubProvider('anthropic', async () => ({
      text: 'ignored',
    }));
    const generator = createPerSessionDistillationGenerator({
      db,
      provider: fakeProvider,
    });
    await generator({
      brainstorm_id: ANCHOR_ID,
      cc_session_id: CC_ID,
      totalChunksInSession: 1,
    });
    const errs = db.listRecentDistillationErrors(20);
    expect(errs[0]!.error_class).toBe('bf4_anthropic_blocked');
  });

  it('writes error_class=provider_threw with verbatim error_message', async () => {
    seedAnchor();
    db.insertBrainstormChunk({
      id: 'c1',
      brainstorm_id: ANCHOR_ID,
      turn_index: 0,
      role: 'user',
      mode: 'conversation',
      text: 'hello',
      model_id: '',
      cc_session_id: CC_ID,
    });
    const fakeProvider = stubProvider('ollama', async () => {
      throw new Error('synthetic provider failure');
    });
    const generator = createPerSessionDistillationGenerator({
      db,
      provider: fakeProvider,
    });
    const result = await generator({
      brainstorm_id: ANCHOR_ID,
      cc_session_id: CC_ID,
      totalChunksInSession: 1,
    });
    expect(result).toBeNull();
    const errs = db.listRecentDistillationErrors(20);
    expect(errs[0]!.error_class).toBe('provider_threw');
    expect(errs[0]!.error_message).toBe('synthetic provider failure');
  });

  it('writes error_class=empty_llm_reply when the model returns an empty string', async () => {
    seedAnchor();
    db.insertBrainstormChunk({
      id: 'c1',
      brainstorm_id: ANCHOR_ID,
      turn_index: 0,
      role: 'user',
      mode: 'conversation',
      text: 'hello',
      model_id: '',
      cc_session_id: CC_ID,
    });
    const fakeProvider = stubProvider('ollama', async () => ({ text: '   ' }));
    const generator = createPerSessionDistillationGenerator({
      db,
      provider: fakeProvider,
    });
    await generator({
      brainstorm_id: ANCHOR_ID,
      cc_session_id: CC_ID,
      totalChunksInSession: 1,
    });
    const errs = db.listRecentDistillationErrors(20);
    expect(errs[0]!.error_class).toBe('empty_llm_reply');
  });

  it('writes error_class=no_session_scoped_chunks when no chunks match the (brainstorm, cc) pair', async () => {
    seedAnchor();
    /* No insertBrainstormChunk call; scoped query returns []. */
    const fakeProvider = stubProvider('ollama', async () => ({
      text: 'unused',
    }));
    const generator = createPerSessionDistillationGenerator({
      db,
      provider: fakeProvider,
    });
    await generator({
      brainstorm_id: ANCHOR_ID,
      cc_session_id: CC_ID,
      totalChunksInSession: 0,
    });
    const errs = db.listRecentDistillationErrors(20);
    expect(errs[0]!.error_class).toBe('no_session_scoped_chunks');
  });
});
