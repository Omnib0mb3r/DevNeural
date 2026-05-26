/**
 * Worker event listener processChange.
 *
 * The chokidar subscription is a thin wrapper; processChange is the
 * orchestrator and where every branch lives. Tests drive it directly
 * with a temp jsonl file and assert the wiring talks to the gate +
 * router + inject spy correctly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IndexDb } from '../src/store/index-db.js';
import { runMigrations } from '../src/db/migrate.js';
import { WorkerEventGate } from '../src/dashboard/worker-event-router.js';
import { newAnchorTailState } from '../src/dashboard/worker-event-detect.js';
import {
  processChange,
  deliverSupervisorPromptToLex,
} from '../src/dashboard/worker-event-listener.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');

let tmpDir: string;
let db: IndexDb;

const CC_ID = 'cc-evt-1111-2222-3333-4444';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-evt-listen-'));
  const dbFile = path.join(tmpDir, 'index.db');
  fs.mkdirSync(path.join(tmpDir, 'home', '.claude', 'projects'), {
    recursive: true,
  });
  fs.mkdirSync(path.join(tmpDir, 'Projects'), { recursive: true });
  process.env.DEVNEURAL_DATA_ROOT = tmpDir;
  process.env.DEVNEURAL_PROJECTS_ROOT = path.join(tmpDir, 'Projects');
  process.env.USERPROFILE = path.join(tmpDir, 'home');
  process.env.HOME = path.join(tmpDir, 'home');
  const idx = new IndexDb(dbFile);
  idx.close();
  await runMigrations({ dbPath: dbFile, migrationsDir: MIGRATIONS_DIR });
  db = new IndexDb(dbFile);
  (db as unknown as { db: { prepare: (sql: string) => { run: () => void } } })
    .db.prepare('DELETE FROM project_session')
    .run();
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function seedAnchor(mode: 'event' | 'polling' | 'off') {
  db.insertProjectSession({
    id: 'anchor-A',
    project_slug: 'proj-a',
    cwd: 'C:/p/a',
    title: 'proj-a',
    status: 'live',
    current_session_id: CC_ID,
    current_bridge_id: 'b-A',
    current_pty_id: 'pty-A',
    created_ms: 1,
    last_seen_ms: 1,
    supervision_mode: mode,
  });
  db.insertProjectTranscriptRef({
    id: 'ref-1',
    anchor_id: 'anchor-A',
    cc_session_id: CC_ID,
    jsonl_path: path.join(tmpDir, `${CC_ID}.jsonl`),
    opened_ms: 1,
    closed_ms: null,
  });
}

function writeJsonl(payloadLines: string[]): string {
  const file = path.join(tmpDir, `${CC_ID}.jsonl`);
  fs.writeFileSync(file, payloadLines.join('\n') + '\n', 'utf-8');
  return file;
}

function injectorSpy() {
  return vi.fn(() => ({ ok: true }));
}

function baseDeps() {
  return {
    db,
    state: new Map(),
    gate: new WorkerEventGate({
      perTypeMinGapMs: 0,
      perAnchorHourlyCap: 999,
      killSwitchPerTenMinutes: 999,
    }),
    inject: injectorSpy(),
    onKillSwitch: vi.fn(),
    resolveTarget: () => 'lex-cc-1',
    now: () => 9_000_000,
  };
}

describe('processChange', () => {
  it('skips files whose cc_session_id has no transcript_ref', () => {
    const file = writeJsonl([
      JSON.stringify({ content: 'irrelevant' }),
    ]);
    const deps = baseDeps();
    const r = processChange(file, deps);
    expect(r.outcome).toBe('skipped-no-anchor');
    expect(deps.inject).not.toHaveBeenCalled();
  });

  it('skips anchors whose supervision_mode is not event', () => {
    seedAnchor('polling');
    const file = writeJsonl([
      JSON.stringify({
        content: 'Permission to use Bash has been denied',
      }),
    ]);
    const deps = baseDeps();
    const r = processChange(file, deps);
    expect(r.outcome).toBe('skipped-mode');
    expect(deps.inject).not.toHaveBeenCalled();
  });

  it('routes permission_denied through to the inject spy', () => {
    seedAnchor('event');
    const file = writeJsonl([
      JSON.stringify({
        content: 'Permission to use Bash has been denied',
      }),
    ]);
    const deps = baseDeps();
    const r = processChange(file, deps);
    expect(r.outcome).toBe('routed');
    expect(r.routed?.[0]?.outcome).toBe('sent');
    expect(deps.inject).toHaveBeenCalledTimes(1);
    const [target, text] = (deps.inject as ReturnType<typeof injectorSpy>).mock
      .calls[0]!;
    expect(target).toBe('lex-cc-1');
    expect(text).toMatch(/\[supervisor-event\] worker=proj-a/);
  });

  it('returns skipped-no-change when the tail signature matches prev state', () => {
    seedAnchor('event');
    const file = writeJsonl([
      JSON.stringify({ content: 'just a line' }),
    ]);
    const deps = baseDeps();
    const stat = fs.statSync(file);
    const sig = `${stat.size}:${Math.round(stat.mtimeMs)}`;
    deps.state.set('anchor-A', {
      ...newAnchorTailState(),
      lastTailSig: sig,
    });
    const r = processChange(file, deps);
    expect(r.outcome).toBe('skipped-no-change');
    expect(deps.inject).not.toHaveBeenCalled();
  });

  it('returns no-events when the tail has no detector hits', () => {
    seedAnchor('event');
    const file = writeJsonl([
      JSON.stringify({ role: 'user', content: 'hi', timestamp: new Date().toISOString() }),
    ]);
    const deps = baseDeps();
    const r = processChange(file, deps);
    expect(r.outcome).toBe('no-events');
  });

  it('persists nextState into the supplied state map', () => {
    seedAnchor('event');
    const ts = new Date(9_000_000 - 1000).toISOString();
    const file = writeJsonl([
      JSON.stringify({ role: 'assistant', timestamp: ts }),
    ]);
    const deps = baseDeps();
    processChange(file, deps);
    const persisted = deps.state.get('anchor-A');
    expect(persisted?.lastAssistantMs).toBe(Date.parse(ts));
  });

  it('fires the kill-switch handler when the gate trips', () => {
    seedAnchor('event');
    const file = writeJsonl([
      JSON.stringify({
        content: 'Permission to use Bash has been denied',
      }),
    ]);
    const deps = baseDeps();
    deps.gate = new WorkerEventGate({
      perTypeMinGapMs: 0,
      perAnchorHourlyCap: 999,
      killSwitchPerTenMinutes: 1,
    });
    /* Pre-fill the gate so the next route trips the kill-switch. */
    deps.gate.evaluate(
      {
        type: 'permission_denied',
        anchor_id: 'anchor-A',
        worker_session_id: CC_ID,
        timestamp: new Date(9_000_000 - 1000).toISOString(),
        snippet: 'x',
      },
      9_000_000 - 1000,
    );
    const r = processChange(file, deps);
    expect(r.routed?.[0]?.outcome).toBe('kill-switch');
    expect(deps.onKillSwitch).toHaveBeenCalledWith('anchor-A');
    expect(deps.inject).not.toHaveBeenCalled();
  });
});

describe('deliverSupervisorPromptToLex (Fix 34d.1: pty routing)', () => {
  it('returns no_lex_transcript_ref when the target cc is not bound to a lex_session', () => {
    const r = deliverSupervisorPromptToLex(db, 'cc-unknown', 'hello', () => ({
      ok: true,
    }));
    expect(r.ok).toBe(false);
    expect(r.mode).toBe('lex-pty');
    expect(r.reason).toBe('no_lex_transcript_ref');
  });

  it('routes via ptyInject keyed on the CC session id (NOT lex_session.id)', () => {
    db.insertLexSession({
      id: 'lex-A',
      created_ms: 1_000,
      title: 'lex-A',
      derived_title: null,
      status: 'live',
      current_pty_id: null,
      cwd: 'C:/p/lex-A',
    });
    db.insertLexTranscriptRef({
      lex_session_id: 'lex-A',
      cc_session_id: 'cc-lex-target',
      transcript_path: 'C:/p/lex-A/cc-lex-target.jsonl',
      started_ms: 1_000,
      ended_ms: null,
      ordering: 0,
    });
    const ptyCalls: Array<{ ccSessionId: string; text: string; commit: boolean }> = [];
    const r = deliverSupervisorPromptToLex(
      db,
      'cc-lex-target',
      '[supervisor-event] sample',
      (ccSessionId, text, commit) => {
        ptyCalls.push({ ccSessionId, text, commit });
        return { ok: true };
      },
    );
    expect(r.ok).toBe(true);
    expect(r.mode).toBe('lex-pty');
    expect(ptyCalls).toHaveLength(1);
    /* Critical contract (Fix 34d.1): inject key is the CC session id
     * we were handed, NOT the lex_session.id resolved off the ref.
     * Keying on lex_session.id was the pre-fix routing bug that sent
     * supervisor payloads to the worker terminal via bridge fallback. */
    expect(ptyCalls[0]?.ccSessionId).toBe('cc-lex-target');
    expect(ptyCalls[0]?.text).toBe('[supervisor-event] sample');
    expect(ptyCalls[0]?.commit).toBe(true);
  });

  it('surfaces ptyInject errors as lex-pty failures', () => {
    db.insertLexSession({
      id: 'lex-down',
      created_ms: 1_000,
      title: null,
      derived_title: null,
      status: 'live',
      current_pty_id: null,
      cwd: 'C:/p/lex-down',
    });
    db.insertLexTranscriptRef({
      lex_session_id: 'lex-down',
      cc_session_id: 'cc-down',
      transcript_path: 'C:/p/lex-down/cc-down.jsonl',
      started_ms: 1_000,
      ended_ms: null,
      ordering: 0,
    });
    const r = deliverSupervisorPromptToLex(
      db,
      'cc-down',
      'x',
      () => ({ ok: false, error: 'pty not found' }),
    );
    expect(r.ok).toBe(false);
    expect(r.mode).toBe('lex-pty');
    expect(r.reason).toBe('pty not found');
  });

  it('does NOT route through writeBridgePrompt / queueSessionPrompt under any branch', async () => {
    /* Belt-and-suspenders contract pin: spy on the sessions module's
     * bridge writer. The Fix 34d.1 spec requires the supervisor wire
     * to be pty-only; any future regression that wires the bridge
     * fallback back in MUST fail this pin loudly. */
    const sessionsModule = await import('../src/dashboard/sessions.js');
    const spy = vi.spyOn(sessionsModule, 'queueSessionPrompt');
    try {
      db.insertLexSession({
        id: 'lex-pin',
        created_ms: 1_000,
        title: null,
        derived_title: null,
        status: 'live',
        current_pty_id: null,
        cwd: 'C:/p/lex-pin',
      });
      db.insertLexTranscriptRef({
        lex_session_id: 'lex-pin',
        cc_session_id: 'cc-pin',
        transcript_path: 'C:/p/lex-pin/cc-pin.jsonl',
        started_ms: 1_000,
        ended_ms: null,
        ordering: 0,
      });
      const r = deliverSupervisorPromptToLex(
        db,
        'cc-pin',
        '[supervisor-event] pin',
        () => ({ ok: true }),
      );
      expect(r.ok).toBe(true);
      expect(r.mode).toBe('lex-pty');
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
