/**
 * Worker event router (EVENT-DRIVEN-SUPERVISION.md).
 *
 * Covers detection helpers, the debounce + rate-limit gate, the
 * supervisor-event payload shape, the Lex target session resolver,
 * and the end-to-end routeWorkerEvent decision tree.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IndexDb } from '../src/store/index-db.js';
import { runMigrations } from '../src/db/migrate.js';
import {
  WorkerEventGate,
  buildSupervisorPrompt,
  debounceDefaults,
  detectCommit,
  detectIdle,
  detectPermissionDenied,
  detectTestFailure,
  resetLexTargetCacheForTest,
  resolveLexTargetSession,
  routeWorkerEvent,
  type WorkerEvent,
} from '../src/dashboard/worker-event-router.js';
import type { ProjectSessionRow } from '../src/store/index-db.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');

function event(over: Partial<WorkerEvent> = {}): WorkerEvent {
  return {
    type: over.type ?? 'idle',
    anchor_id: over.anchor_id ?? 'anchor-A',
    worker_session_id: over.worker_session_id ?? 'cc-A',
    timestamp: over.timestamp ?? new Date(1_000_000).toISOString(),
    snippet: over.snippet ?? 'sample tail',
  };
}

function anchor(over: Partial<ProjectSessionRow> = {}): ProjectSessionRow {
  return {
    id: 'anchor-A',
    project_slug: 'proj-a',
    cwd: 'C:/p/a',
    title: over.title ?? null,
    status: 'live',
    current_session_id: 'cc-A',
    current_bridge_id: 'b-A',
    current_pty_id: null,
    created_ms: 1,
    last_seen_ms: 1,
    ...over,
  };
}

describe('detectPermissionDenied', () => {
  it('matches the canonical CC permission-denied phrase', () => {
    expect(
      detectPermissionDenied('"Permission to use Bash has been denied"'),
    ).toBe(true);
    expect(
      detectPermissionDenied('Permission to use Write_File has been denied'),
    ).toBe(true);
  });

  it('does not match similar but distinct phrases', () => {
    expect(detectPermissionDenied('permission granted')).toBe(false);
    expect(
      detectPermissionDenied('the worker was denied a permission slip'),
    ).toBe(false);
  });
});

describe('detectTestFailure', () => {
  it('flags vitest with explicit Tests failed signal', () => {
    expect(
      detectTestFailure(
        '"command":"vitest run","output":"Tests failed: 3 of 12"',
      ),
    ).toBe(true);
  });

  it('flags exit code non-zero with a runner present', () => {
    expect(
      detectTestFailure(
        '"command":"npm","args":["test"],"exit code 1"',
      ),
    ).toBe(true);
  });

  it('does not fire without a test runner mention', () => {
    expect(detectTestFailure('exit code 1 from some other process')).toBe(
      false,
    );
  });
});

describe('detectCommit', () => {
  it('detects git commit success via files changed line', () => {
    expect(
      detectCommit('git commit -m "fix" ... 3 files changed, 9 insertions'),
    ).toBe(true);
  });

  it('detects git commit success via [branch hash] line', () => {
    expect(detectCommit('[master 1a2b3c4] some message')).toBe(true);
  });

  it('does not fire on plain mentions of commit in chat', () => {
    expect(detectCommit('we should commit this later')).toBe(false);
  });
});

describe('detectIdle', () => {
  it('returns true when last assistant message is older than threshold', () => {
    expect(
      detectIdle({
        lastAssistantMs: 1_000_000,
        pendingToolUse: false,
        now: 1_000_000 + 11 * 60 * 1000,
        thresholdMs: 10 * 60 * 1000,
      }),
    ).toBe(true);
  });

  it('returns false when a tool_use is pending', () => {
    expect(
      detectIdle({
        lastAssistantMs: 1_000_000,
        pendingToolUse: true,
        now: 1_000_000 + 60 * 60 * 1000,
        thresholdMs: 10 * 60 * 1000,
      }),
    ).toBe(false);
  });

  it('returns false when no assistant message has been seen yet', () => {
    expect(
      detectIdle({
        lastAssistantMs: null,
        pendingToolUse: false,
        now: 1_000_000_000,
        thresholdMs: 10 * 60 * 1000,
      }),
    ).toBe(false);
  });
});

describe('WorkerEventGate', () => {
  it('accepts the first event, debounces a same-type retry within the gap', () => {
    const gate = new WorkerEventGate(debounceDefaults());
    const e = event({ type: 'permission_denied' });
    expect(gate.evaluate(e, 1_000_000).decision).toBe('accept');
    const r = gate.evaluate(e, 1_000_000 + 60 * 1000);
    expect(r.decision).toBe('debounce');
    if (r.decision === 'debounce') {
      expect(r.reason).toBe('per-type-gap');
    }
  });

  it('accepts different event types independently', () => {
    const gate = new WorkerEventGate(debounceDefaults());
    const e1 = event({ type: 'permission_denied' });
    const e2 = event({ type: 'idle' });
    expect(gate.evaluate(e1, 1).decision).toBe('accept');
    expect(gate.evaluate(e2, 2).decision).toBe('accept');
  });

  it('debounces on hourly cap', () => {
    const gate = new WorkerEventGate({
      perTypeMinGapMs: 0,
      perAnchorHourlyCap: 3,
      killSwitchPerTenMinutes: 999,
    });
    for (let i = 0; i < 3; i++) {
      expect(
        gate.evaluate(event({ type: 'idle' }), 1000 + i).decision,
      ).toBe('accept');
    }
    const r = gate.evaluate(event({ type: 'idle' }), 2000);
    expect(r.decision).toBe('debounce');
    if (r.decision === 'debounce') {
      expect(r.reason).toBe('hourly-cap');
    }
  });

  it('trips kill-switch when too many events fire in 10 minutes', () => {
    const gate = new WorkerEventGate({
      perTypeMinGapMs: 0,
      perAnchorHourlyCap: 999,
      killSwitchPerTenMinutes: 5,
    });
    for (let i = 0; i < 5; i++) {
      gate.evaluate(event({ type: 'idle' }), 1000 + i);
    }
    expect(
      gate.evaluate(event({ type: 'idle' }), 2000).decision,
    ).toBe('kill-switch');
  });

  it('tracks state per anchor, not globally', () => {
    const gate = new WorkerEventGate({
      perTypeMinGapMs: 60_000,
      perAnchorHourlyCap: 999,
      killSwitchPerTenMinutes: 999,
    });
    expect(
      gate.evaluate(event({ anchor_id: 'a', type: 'idle' }), 1).decision,
    ).toBe('accept');
    expect(
      gate.evaluate(event({ anchor_id: 'b', type: 'idle' }), 2).decision,
    ).toBe('accept');
  });
});

describe('buildSupervisorPrompt', () => {
  it('opens with the [supervisor-event] marker and includes the snippet', () => {
    const text = buildSupervisorPrompt({
      anchorLabel: 'DevNeural',
      event: event({
        type: 'permission_denied',
        snippet: '"Permission to use Bash has been denied"',
      }),
    });
    expect(text.startsWith('[supervisor-event] worker=DevNeural event=permission_denied at')).toBe(
      true,
    );
    expect(text).toMatch(/Snippet:/);
    expect(text).toMatch(/Permission to use Bash has been denied/);
    expect(text).toMatch(
      /Decide: re-inject worker, widen permissions, escalate to user/,
    );
  });

  it('replaces an empty snippet with "(no snippet)"', () => {
    const text = buildSupervisorPrompt({
      anchorLabel: 'DevNeural',
      event: event({ snippet: '' }),
    });
    expect(text).toMatch(/Snippet:\n\(no snippet\)/);
  });
});

describe('routeWorkerEvent', () => {
  it('sends through the inject when the gate accepts and target resolves', () => {
    const inject = vi.fn(() => ({ ok: true }));
    const r = routeWorkerEvent(event(), {
      gate: new WorkerEventGate(debounceDefaults()),
      resolveTarget: () => 'lex-cc-1',
      inject,
      anchor: anchor({ title: 'DevNeural' }),
    });
    expect(r.outcome).toBe('sent');
    expect(inject).toHaveBeenCalledTimes(1);
    const [target, text] = inject.mock.calls[0]!;
    expect(target).toBe('lex-cc-1');
    expect(text).toMatch(/\[supervisor-event\] worker=DevNeural/);
  });

  it('returns no-target when the Lex target resolver yields null', () => {
    const inject = vi.fn(() => ({ ok: true }));
    const r = routeWorkerEvent(event(), {
      gate: new WorkerEventGate(debounceDefaults()),
      resolveTarget: () => null,
      inject,
      anchor: anchor(),
    });
    expect(r.outcome).toBe('no-target');
    expect(inject).not.toHaveBeenCalled();
  });

  it('returns debounced and does not inject on gap', () => {
    const gate = new WorkerEventGate(debounceDefaults());
    const inject = vi.fn(() => ({ ok: true }));
    const deps = {
      gate,
      resolveTarget: () => 'lex-cc-1',
      inject,
      anchor: anchor(),
    } as const;
    routeWorkerEvent(event(), deps);
    const r = routeWorkerEvent(event(), { ...deps, now: 1_000 });
    expect(r.outcome).toBe('debounced');
    expect(inject).toHaveBeenCalledTimes(1);
  });

  it('returns inject-failed when the cross-session inject reports !ok', () => {
    const inject = vi.fn(() => ({ ok: false, reason: 'rejected_allowlist' }));
    const r = routeWorkerEvent(event(), {
      gate: new WorkerEventGate(debounceDefaults()),
      resolveTarget: () => 'lex-cc-1',
      inject,
      anchor: anchor(),
    });
    expect(r.outcome).toBe('inject-failed');
  });

  it('returns kill-switch and calls the handler when the gate trips', () => {
    const cfg = {
      perTypeMinGapMs: 0,
      perAnchorHourlyCap: 999,
      killSwitchPerTenMinutes: 1,
    };
    const gate = new WorkerEventGate(cfg);
    gate.evaluate(event(), 1);
    const onKillSwitch = vi.fn();
    const inject = vi.fn(() => ({ ok: true }));
    const r = routeWorkerEvent(event(), {
      gate,
      resolveTarget: () => 'lex-cc-1',
      inject,
      anchor: anchor(),
      onKillSwitch,
      now: 2,
    });
    expect(r.outcome).toBe('kill-switch');
    expect(onKillSwitch).toHaveBeenCalledWith('anchor-A');
    expect(inject).not.toHaveBeenCalled();
  });
});

/* ── resolveLexTargetSession ──────────────────────────────────────── */

let tmpDir: string;
let db: IndexDb;
let priors: {
  DEVNEURAL_DATA_ROOT?: string;
  USERPROFILE?: string;
  HOME?: string;
};

beforeEach(async () => {
  resetLexTargetCacheForTest();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-worker-router-'));
  const dbFile = path.join(tmpDir, 'index.db');
  fs.mkdirSync(path.join(tmpDir, 'home', '.claude', 'projects'), {
    recursive: true,
  });
  priors = {
    DEVNEURAL_DATA_ROOT: process.env.DEVNEURAL_DATA_ROOT,
    USERPROFILE: process.env.USERPROFILE,
    HOME: process.env.HOME,
  };
  process.env.DEVNEURAL_DATA_ROOT = tmpDir;
  process.env.USERPROFILE = path.join(tmpDir, 'home');
  process.env.HOME = path.join(tmpDir, 'home');
  const idx = new IndexDb(dbFile);
  idx.close();
  await runMigrations({ dbPath: dbFile, migrationsDir: MIGRATIONS_DIR });
  db = new IndexDb(dbFile);
});

afterEach(() => {
  db.close();
  for (const [k, v] of Object.entries(priors)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('resolveLexTargetSession', () => {
  it('returns null when no live lex_session exists', () => {
    expect(resolveLexTargetSession(db, { now: 1_000 })).toBeNull();
  });

  it('returns the cc_session_id of the open transcript_ref under the live lex_session', () => {
    db.insertLexSession({
      id: 'lex-1',
      created_ms: 1000,
      title: 'demo',
      derived_title: null,
      status: 'live',
      current_pty_id: null,
      cwd: 'C:/p/lex',
    });
    db.insertLexTranscriptRef({
      lex_session_id: 'lex-1',
      cc_session_id: 'cc-current',
      transcript_path: 'C:/p/lex/cc-current.jsonl',
      started_ms: 1000,
      ended_ms: null,
      ordering: 0,
    });
    resetLexTargetCacheForTest();
    expect(resolveLexTargetSession(db, { now: 5_000 })).toBe('cc-current');
  });

  it('caches the resolution for ttlMs', () => {
    db.insertLexSession({
      id: 'lex-1',
      created_ms: 1000,
      title: 'demo',
      derived_title: null,
      status: 'live',
      current_pty_id: null,
      cwd: 'C:/p/lex',
    });
    db.insertLexTranscriptRef({
      lex_session_id: 'lex-1',
      cc_session_id: 'cc-original',
      transcript_path: 'C:/p/lex/cc-original.jsonl',
      started_ms: 1000,
      ended_ms: null,
      ordering: 0,
    });
    resetLexTargetCacheForTest();
    expect(resolveLexTargetSession(db, { now: 5_000, ttlMs: 60_000 })).toBe(
      'cc-original',
    );
    /* New ref lands, cache still holds the original. */
    db.insertLexTranscriptRef({
      lex_session_id: 'lex-1',
      cc_session_id: 'cc-newer',
      transcript_path: 'C:/p/lex/cc-newer.jsonl',
      started_ms: 6_000,
      ended_ms: null,
      ordering: 1,
    });
    expect(resolveLexTargetSession(db, { now: 5_500, ttlMs: 60_000 })).toBe(
      'cc-original',
    );
  });

  /* Fix 34c regression. Every brainstorm ref in production has
   * ended_ms === null because the per-ref close-out path never runs.
   * Pre-fix the resolver called `refs.find(r => r.ended_ms === null)`
   * against an ASC-ordered list and matched ordering=0 -- the OLDEST
   * cc_session, typically weeks stale with no bridge presence. Walk
   * newest-first so the most recent open ref wins. */
  it('returns the highest-ordering open ref, not the oldest one', () => {
    db.insertLexSession({
      id: 'lex-stack',
      created_ms: 1_000,
      title: 'multi-ref',
      derived_title: null,
      status: 'live',
      current_pty_id: null,
      cwd: 'C:/p/lex-stack',
    });
    /* Insert in ASC order to mirror production: ordering 0 is the
     * oldest, ordering N-1 is the live current session. All have
     * ended_ms=null because close-out never ran. */
    for (let i = 0; i < 5; i++) {
      db.insertLexTranscriptRef({
        lex_session_id: 'lex-stack',
        cc_session_id: `cc-${i.toString().padStart(2, '0')}`,
        transcript_path: `C:/p/lex-stack/cc-${i}.jsonl`,
        started_ms: 1_000 + i * 100,
        ended_ms: null,
        ordering: i,
      });
    }
    resetLexTargetCacheForTest();
    /* Pre-fix verdict was 'cc-00' (ordering=0). Post-fix the newest
     * open ref wins -- 'cc-04'. */
    expect(resolveLexTargetSession(db, { now: 2_000 })).toBe('cc-04');
  });

  /* Fix 34 regression. Two live lex_sessions exist; only one is
   * bound to the project anchor that the worker event came from.
   * Pre-fix the resolver picked the most-recently-created live
   * session globally and silently delivered into the wrong Lex
   * (or into none when the global pick had no open ref). */
  it('prefers the lex_session bound via supervises_project_anchor_id over the most-recent live row', () => {
    db.insertProjectSession({
      id: 'project-anchor-aaaa',
      project_slug: 'proj-aaaa',
      cwd: 'C:/p/aaaa',
      title: null,
      status: 'live',
      current_session_id: null,
      current_bridge_id: null,
      current_pty_id: null,
      created_ms: 500,
      last_seen_ms: 500,
      supervision_mode: 'event',
    });
    db.insertLexSession({
      id: 'lex-wrong',
      created_ms: 10_000,
      title: 'unbound newer',
      derived_title: null,
      status: 'live',
      current_pty_id: null,
      cwd: 'C:/p/lex-wrong',
    });
    db.insertLexTranscriptRef({
      lex_session_id: 'lex-wrong',
      cc_session_id: 'cc-wrong',
      transcript_path: 'C:/p/lex-wrong/cc-wrong.jsonl',
      started_ms: 10_000,
      ended_ms: null,
      ordering: 0,
    });
    db.insertLexSession({
      id: 'lex-right',
      created_ms: 1_000,
      title: 'bound older',
      derived_title: null,
      status: 'live',
      current_pty_id: null,
      cwd: 'C:/p/lex-right',
      supervises_project_anchor_id: 'project-anchor-aaaa',
    });
    db.insertLexTranscriptRef({
      lex_session_id: 'lex-right',
      cc_session_id: 'cc-right',
      transcript_path: 'C:/p/lex-right/cc-right.jsonl',
      started_ms: 1_000,
      ended_ms: null,
      ordering: 0,
    });
    resetLexTargetCacheForTest();
    /* Without anchorId: legacy behaviour picks the most recent
     * live row (cc-wrong). */
    expect(resolveLexTargetSession(db, { now: 12_000 })).toBe('cc-wrong');
    resetLexTargetCacheForTest();
    /* With anchorId: anchor-scoped lookup wins. */
    expect(
      resolveLexTargetSession(db, {
        now: 12_000,
        anchorId: 'project-anchor-aaaa',
      }),
    ).toBe('cc-right');
  });

  it('falls back to global pick when the project anchor has no supervisor bound', () => {
    db.insertLexSession({
      id: 'lex-only',
      created_ms: 1_000,
      title: 'unbound',
      derived_title: null,
      status: 'live',
      current_pty_id: null,
      cwd: 'C:/p/lex-only',
    });
    db.insertLexTranscriptRef({
      lex_session_id: 'lex-only',
      cc_session_id: 'cc-fallback',
      transcript_path: 'C:/p/lex-only/cc-fallback.jsonl',
      started_ms: 1_000,
      ended_ms: null,
      ordering: 0,
    });
    resetLexTargetCacheForTest();
    expect(
      resolveLexTargetSession(db, {
        now: 5_000,
        anchorId: 'project-anchor-no-supervisor',
      }),
    ).toBe('cc-fallback');
  });

  it('caches per-anchor so a miss on one project does not poison another', () => {
    db.insertProjectSession({
      id: 'proj-A',
      project_slug: 'proj-A',
      cwd: 'C:/p/A',
      title: null,
      status: 'live',
      current_session_id: null,
      current_bridge_id: null,
      current_pty_id: null,
      created_ms: 500,
      last_seen_ms: 500,
      supervision_mode: 'event',
    });
    db.insertLexSession({
      id: 'lex-A',
      created_ms: 1_000,
      title: 'A',
      derived_title: null,
      status: 'live',
      current_pty_id: null,
      cwd: 'C:/p/lex-A',
      supervises_project_anchor_id: 'proj-A',
    });
    db.insertLexTranscriptRef({
      lex_session_id: 'lex-A',
      cc_session_id: 'cc-A',
      transcript_path: 'C:/p/lex-A/cc-A.jsonl',
      started_ms: 1_000,
      ended_ms: null,
      ordering: 0,
    });
    resetLexTargetCacheForTest();
    /* First call for proj-B finds nothing (no supervisor, no global
     * either - we have a lex_session but its supervises field is
     * proj-A). Global fallback still returns lex-A's cc id. */
    expect(
      resolveLexTargetSession(db, { now: 1_000, anchorId: 'proj-B' }),
    ).toBe('cc-A');
    /* Subsequent call for proj-A is NOT poisoned by the proj-B
     * lookup; the anchor-scoped resolver hits a separate cache key. */
    expect(
      resolveLexTargetSession(db, { now: 1_100, anchorId: 'proj-A' }),
    ).toBe('cc-A');
  });
});
