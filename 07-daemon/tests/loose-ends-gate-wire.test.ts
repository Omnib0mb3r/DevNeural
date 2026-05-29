/**
 * LEX-AUTONOMY codex 10a (Fix 47 partial closure step 1) - production
 * fireAutoAction wire pins.
 *
 * Exercises createLooseEndsFireAutoAction directly against a tmp DB
 * with stubbed crossSessionInject / perSessionGenerator transports.
 * The four pins required by the codex 10a spec:
 *
 *   1. mid_tool auto-resolves via cross-session-inject with
 *      caller_label='loose-ends-auto-resolve' and the canonical
 *      recovery body.
 *   2. distill_error auto-resolves via per-session distillation
 *      generator + ref_summary write-through + audit row.
 *   3. undistilled_ref takes the same redistill path as distill_error.
 *   4. Operator-disposition classes (parked_question, dirty_worktree,
 *      open_audit_finding) are filtered upstream by
 *      enforceLooseEndsGate, so a report containing one returns
 *      kind='blocked' with empty auto_actions even when an auto
 *      class is also present. The dispatcher never sees the
 *      operator classes; the gate decision shape is the contract
 *      under test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IndexDb } from '../src/store/index-db.js';
import { runMigrations } from '../src/db/migrate.js';
import { createLooseEndsFireAutoAction } from '../src/lex/loose-ends-auto-actions.js';
import { enforceLooseEndsGate } from '../src/lex/loose-ends-gate.js';
import { RECOVERY_INJECT_BODY } from '../src/lex/cancelled-tool-recovery.js';
import type { InjectResult } from '../src/lex/cross-session-inject.js';
import type { LooseEnd } from '../src/lex/loose-ends-gate.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');

const ANCHOR = 'codex10a-anchor';
const CC = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const NOW = 5_000_000;

let tmpDir: string;
let db: IndexDb;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-codex10a-'));
  const dbFile = path.join(tmpDir, 'index.db');
  const seed = new IndexDb(dbFile);
  seed.close();
  await runMigrations({ dbPath: dbFile, migrationsDir: MIGRATIONS_DIR });
  db = new IndexDb(dbFile);
  db.insertBrainstorm({
    id: ANCHOR,
    claude_session_id: CC,
    pty_id: null,
    cwd: 'C:/dev/codex10a',
    user_label: 'codex10a',
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
    cwd: 'C:/dev/codex10a',
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

function readAuditRows(callerLabel: string): {
  caller_label: string | null;
  target_session: string;
  decision: string;
  text_preview: string;
}[] {
  return (db as unknown as {
    db: {
      prepare: (sql: string) => {
        all: (...params: string[]) => unknown[];
      };
    };
  }).db
    .prepare(
      `SELECT caller_label, target_session, decision, text_preview
         FROM cross_session_injection_log
        WHERE caller_label = ?
        ORDER BY ts ASC`,
    )
    .all(callerLabel) as {
    caller_label: string | null;
    target_session: string;
    decision: string;
    text_preview: string;
  }[];
}

describe('createLooseEndsFireAutoAction (codex 10a)', () => {
  it('pin 1: mid_tool fires cross-session-inject with caller_label=loose-ends-auto-resolve + recovery body', async () => {
    const injectStub = vi.fn(
      (): InjectResult => ({ ok: true, decision: 'accepted', transport: 'pty' }),
    );
    const fire = createLooseEndsFireAutoAction({
      db,
      anchorId: ANCHOR,
      crossSessionInject: injectStub,
      issueToken: () => 'test-token',
    });
    const end: LooseEnd = {
      class: 'mid_tool',
      disposition: 'auto',
      severity: 'warn',
      detail: '1 tool_use without tool_result',
      evidence_cc_session_id: CC,
    };
    const result = await fire(end);
    expect(result.status).toBe('fired');
    expect(result.action).toBe('recovery-inject');
    expect(result.target).toBe(CC);
    expect(injectStub).toHaveBeenCalledTimes(1);
    const call = injectStub.mock.calls[0]!;
    expect(call[0]).toMatchObject({
      target_session: CC,
      text: RECOVERY_INJECT_BODY,
      caller_label: 'loose-ends-auto-resolve',
      commit: true,
      anchor_id: ANCHOR,
    });
  });

  it('pin 2: distill_error fires redistill via per-session generator + writes ref_summary + audit row', async () => {
    const refId = db.insertLexTranscriptRef({
      lex_session_id: ANCHOR,
      cc_session_id: CC,
      transcript_path: '/tmp/codex10a.jsonl',
      started_ms: 100,
      ended_ms: 200,
      ordering: 0,
    }).id;
    const generatorStub = vi.fn(async () => ({
      summary: 'rebuilt distillation body',
      source_chunk_count: 5,
      source_session_ids: CC,
      coverage_score: 0.75,
    }));
    const fire = createLooseEndsFireAutoAction({
      db,
      anchorId: ANCHOR,
      perSessionGenerator: generatorStub,
      now: () => NOW,
    });
    const end: LooseEnd = {
      class: 'distill_error',
      disposition: 'auto',
      severity: 'warn',
      detail: 'recent distillation error rows',
      evidence_cc_session_id: CC,
    };
    const result = await fire(end);
    expect(result.status).toBe('fired');
    expect(result.action).toBe('redistill');
    expect(result.target).toBe(CC);
    expect(generatorStub).toHaveBeenCalledTimes(1);
    expect(generatorStub.mock.calls[0]![0]).toMatchObject({
      brainstorm_id: ANCHOR,
      cc_session_id: CC,
    });
    /* ref_summary written through, provenance fields carried */
    const refs = db.listLexTranscriptRefs(ANCHOR);
    const ref = refs.find((r) => r.id === refId)!;
    expect(ref.ref_summary).toBe('rebuilt distillation body');
    expect(ref.ref_summary_ms).toBe(NOW);
    expect(ref.coverage_score).toBe(0.75);
    /* Audit row landed with the right caller_label + brainstorm_id */
    const rows = readAuditRows('loose-ends-auto-resolve');
    expect(rows.length).toBe(1);
    expect(rows[0]!.target_session).toBe(CC);
    expect(rows[0]!.decision).toBe('accepted');
    expect(rows[0]!.text_preview).toContain('rebuilt distillation');
  });

  it('pin 3: undistilled_ref takes the same redistill path (generator + ref + audit)', async () => {
    db.insertLexTranscriptRef({
      lex_session_id: ANCHOR,
      cc_session_id: CC,
      transcript_path: '/tmp/codex10a.jsonl',
      started_ms: 100,
      ended_ms: 200,
      ordering: 0,
    });
    const generatorStub = vi.fn(async () => ({
      summary: 'late distillation arrives',
      source_chunk_count: 3,
      source_session_ids: CC,
      coverage_score: 0.5,
    }));
    const fire = createLooseEndsFireAutoAction({
      db,
      anchorId: ANCHOR,
      perSessionGenerator: generatorStub,
      now: () => NOW,
    });
    const end: LooseEnd = {
      class: 'undistilled_ref',
      disposition: 'auto',
      severity: 'warn',
      detail: 'ref ended without ref_summary',
      evidence_cc_session_id: CC,
    };
    const result = await fire(end);
    expect(result.status).toBe('fired');
    expect(result.action).toBe('redistill');
    expect(result.target).toBe(CC);
    expect(generatorStub).toHaveBeenCalledTimes(1);
    const rows = readAuditRows('loose-ends-auto-resolve');
    expect(rows.length).toBe(1);
    /* Audit reject_reason JSON encodes the underlying class so the
     * dashboard can render distill_error vs undistilled_ref distinctly
     * even though both route through the same redistill action. */
    const reason = (db as unknown as {
      db: { prepare: (sql: string) => { get: () => unknown } };
    }).db
      .prepare(
        `SELECT reject_reason FROM cross_session_injection_log
          WHERE caller_label = 'loose-ends-auto-resolve' LIMIT 1`,
      )
      .get() as { reject_reason: string };
    const parsed = JSON.parse(reason.reject_reason) as { class: string };
    expect(parsed.class).toBe('undistilled_ref');
  });

  it('pin 4: operator classes still block the gate even when auto classes are also present', async () => {
    /* Seed an undistilled_ref AND a dirty_worktree at the same time.
     * The auto class would otherwise fire redistill; the operator
     * class must dominate so kind='blocked' and no auto action runs. */
    db.insertLexTranscriptRef({
      lex_session_id: ANCHOR,
      cc_session_id: CC,
      transcript_path: '/tmp/codex10a.jsonl',
      started_ms: 100,
      ended_ms: 200,
      ordering: 0,
    });
    const generatorStub = vi.fn(async () => ({
      summary: 'should-never-fire',
      source_chunk_count: 1,
      source_session_ids: CC,
      coverage_score: 0,
    }));
    const fire = createLooseEndsFireAutoAction({
      db,
      anchorId: ANCHOR,
      perSessionGenerator: generatorStub,
      now: () => NOW,
    });
    const decision = await enforceLooseEndsGate(db, ANCHOR, {
      fireAutoAction: fire,
      runGit: () => ' M dirty-file.txt\n',
      readTranscript: () => null,
    });
    expect(decision.kind).toBe('blocked');
    expect(decision.auto_actions).toEqual([]);
    expect(generatorStub).not.toHaveBeenCalled();
    /* Report still surfaces both ends for the dashboard banner. */
    const classes = decision.report.ends.map((e) => e.class).sort();
    expect(classes).toContain('dirty_worktree');
    expect(classes).toContain('undistilled_ref');
  });
});
