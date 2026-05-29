/**
 * LEX-AUTONOMY codex 10b (Fix 47 partial closure step 2) - dashboard
 * spawn preflight pins.
 *
 * POST /projects/:id/start-claude now runs the loose-ends gate when
 * the caller supplies an anchor_id. The gate evaluation is exercised
 * through preflightLooseEndsForSpawn which the route handler also
 * uses; testing the helper directly keeps the contract pinned without
 * having to boot fastify + identity-registry + child_process spawns.
 *
 * Three pins:
 *   1. anchor with no loose ends -> blocked=false, decision.kind='clear'.
 *   2. anchor with a dirty_worktree loose end (operator disposition) ->
 *      blocked=true, decision.kind='blocked', report.ends carries
 *      dirty_worktree.
 *   3. anchor with only an auto class (mid_tool) and a fireAutoAction
 *      stubbed via the gate enforce seam -> blocked=false,
 *      decision.kind='auto-resolving'.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IndexDb } from '../src/store/index-db.js';
import { runMigrations } from '../src/db/migrate.js';
import { preflightLooseEndsForSpawn } from '../src/lex/loose-ends-auto-actions.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');

const ANCHOR = 'codex10b-anchor';
const CC = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';

let tmpDir: string;
let db: IndexDb;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-codex10b-'));
  const dbFile = path.join(tmpDir, 'index.db');
  const seed = new IndexDb(dbFile);
  seed.close();
  await runMigrations({ dbPath: dbFile, migrationsDir: MIGRATIONS_DIR });
  db = new IndexDb(dbFile);
  db.insertBrainstorm({
    id: ANCHOR,
    claude_session_id: CC,
    pty_id: null,
    cwd: 'C:/dev/codex10b',
    user_label: 'codex10b',
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
    id: ANCHOR,
    created_ms: 1,
    title: null,
    derived_title: null,
    status: 'live',
    current_pty_id: null,
    cwd: 'C:/dev/codex10b',
  });
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* */
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('preflightLooseEndsForSpawn (codex 10b)', () => {
  it('pin 1: anchor with no loose ends returns blocked=false and decision.kind=clear', async () => {
    const result = await preflightLooseEndsForSpawn(db, ANCHOR, {
      /* No refs, no jsonl, no dirty worktree -> evaluateLooseEnds
       * returns an empty report. */
      enforce: async (innerDb, innerAnchor, opts) => {
        const { enforceLooseEndsGate } = await import(
          '../src/lex/loose-ends-gate.js'
        );
        return enforceLooseEndsGate(innerDb, innerAnchor, {
          fireAutoAction: opts.fireAutoAction,
          runGit: () => null,
          readTranscript: () => null,
        });
      },
    });
    expect(result.blocked).toBe(false);
    expect(result.decision?.kind).toBe('clear');
  });

  it('pin 2: anchor with a dirty_worktree (operator) blocks the spawn', async () => {
    const result = await preflightLooseEndsForSpawn(db, ANCHOR, {
      enforce: async (innerDb, innerAnchor, opts) => {
        const { enforceLooseEndsGate } = await import(
          '../src/lex/loose-ends-gate.js'
        );
        return enforceLooseEndsGate(innerDb, innerAnchor, {
          fireAutoAction: opts.fireAutoAction,
          runGit: () => ' M dirty-file.txt\n',
          readTranscript: () => null,
        });
      },
    });
    expect(result.blocked).toBe(true);
    expect(result.decision?.kind).toBe('blocked');
    const classes = result.decision?.report.ends.map((e) => e.class) ?? [];
    expect(classes).toContain('dirty_worktree');
  });

  it('pin 3: anchor with only auto-disposition classes auto-resolves and lets spawn proceed', async () => {
    /* Seed an undistilled_ref (auto class) and supply a stub
     * generator so the dispatcher fires successfully. The gate
     * decision must come back kind='auto-resolving' and the
     * preflight wrapper must report blocked=false. */
    db.insertLexTranscriptRef({
      lex_session_id: ANCHOR,
      cc_session_id: CC,
      transcript_path: '/tmp/codex10b.jsonl',
      started_ms: 100,
      ended_ms: 200,
      ordering: 0,
    });
    const generatorStub = vi.fn(async () => ({
      summary: 'auto-resolve fixture distillation',
      source_chunk_count: 1,
      source_session_ids: CC,
      coverage_score: 0.42,
    }));
    const result = await preflightLooseEndsForSpawn(db, ANCHOR, {
      perSessionGenerator: generatorStub,
      enforce: async (innerDb, innerAnchor, opts) => {
        const { enforceLooseEndsGate } = await import(
          '../src/lex/loose-ends-gate.js'
        );
        return enforceLooseEndsGate(innerDb, innerAnchor, {
          fireAutoAction: opts.fireAutoAction,
          runGit: () => null,
          readTranscript: () => null,
        });
      },
    });
    expect(result.blocked).toBe(false);
    expect(result.decision?.kind).toBe('auto-resolving');
    expect(generatorStub).toHaveBeenCalledTimes(1);
    /* Gate exercised the auto dispatcher. */
    const actions = result.decision?.auto_actions ?? [];
    const undistilled = actions.find((a) => a.class === 'undistilled_ref');
    expect(undistilled?.status).toBe('fired');
  });
});
