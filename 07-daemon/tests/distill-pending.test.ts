/* SM-23 pins: pending-distill tracker.
 *
 * The End button hang fix moved every terminal session-end run
 * through queueSessionEndPipeline: marker persisted before the run,
 * cleared only on success, kept (with last_error) on failure so the
 * cold-start gate retries; awaitPendingDistill joins in-flight runs,
 * forces marker-recovered runs, and NEVER waits past its cap. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'distill-pending-'));
process.env.DEVNEURAL_DATA_ROOT = tmpRoot.replace(/\\/g, '/');

vi.mock('../src/lex/session-end-pipeline.js', () => ({
  runSessionEndPipeline: vi.fn(),
}));

import { runSessionEndPipeline } from '../src/lex/session-end-pipeline.js';
import {
  queueSessionEndPipeline,
  awaitPendingDistill,
  readPendingMarker,
  _resetInFlightForTests,
} from '../src/lex/distill-pending.js';
import type { Store } from '../src/store/index.js';

const mockRun = runSessionEndPipeline as unknown as ReturnType<typeof vi.fn>;
const store = {} as Store;

const OK_RESULT = {
  ingest_triggered: false,
  ingest_pages_created: 0,
  ingest_pages_updated: 0,
  summary_written: true,
  summary_embedded: true,
  drafts_created: 1,
  was_primary_runner: true,
  thread_doc_written: false,
};

const input = (id: string) => ({
  brainstormId: id,
  claudeSessionId: 'cc-1',
  mode: 'conversation',
  reason: 'dashboard-end-button',
});

beforeEach(() => {
  _resetInFlightForTests();
  mockRun.mockReset();
});

afterEach(() => {
  const dir = path.join(tmpRoot, 'lex', 'distill-pending');
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f));
  }
});

describe('queueSessionEndPipeline', () => {
  it('persists the marker before the run and clears it on success', async () => {
    let resolveRun: (v: unknown) => void = () => undefined;
    mockRun.mockReturnValue(new Promise((r) => (resolveRun = r)));
    const p = queueSessionEndPipeline(store, input('bs-ok'));
    expect(readPendingMarker('bs-ok')).toMatchObject({
      brainstorm_id: 'bs-ok',
      reason: 'dashboard-end-button',
    });
    resolveRun(OK_RESULT);
    await p;
    expect(readPendingMarker('bs-ok')).toBeNull();
  });

  it('keeps the marker with last_error on failure so the cold start retries', async () => {
    mockRun.mockRejectedValue(new Error('headless died'));
    await expect(queueSessionEndPipeline(store, input('bs-fail'))).rejects.toThrow(
      'headless died',
    );
    const marker = readPendingMarker('bs-fail');
    expect(marker?.last_error).toBe('headless died');
  });

  it('joins an in-flight run instead of double-running', async () => {
    let resolveRun: (v: unknown) => void = () => undefined;
    mockRun.mockReturnValue(new Promise((r) => (resolveRun = r)));
    const a = queueSessionEndPipeline(store, input('bs-join'));
    const b = queueSessionEndPipeline(store, input('bs-join'));
    expect(a).toBe(b);
    expect(mockRun).toHaveBeenCalledTimes(1);
    resolveRun(OK_RESULT);
    await a;
  });
});

describe('awaitPendingDistill', () => {
  it('returns none when nothing is owed', async () => {
    const r = await awaitPendingDistill(store, 'bs-none');
    expect(r.outcome).toBe('none');
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('joins an in-flight run and reports completed', async () => {
    let resolveRun: (v: unknown) => void = () => undefined;
    mockRun.mockReturnValue(new Promise((r) => (resolveRun = r)));
    const run = queueSessionEndPipeline(store, input('bs-wait'));
    const gate = awaitPendingDistill(store, 'bs-wait', undefined, 5_000);
    resolveRun(OK_RESULT);
    await run;
    const r = await gate;
    expect(r.outcome).toBe('completed');
  });

  it('forces a run from a surviving marker (daemon-restart recovery)', async () => {
    mockRun.mockRejectedValueOnce(new Error('killed mid-run'));
    await queueSessionEndPipeline(store, input('bs-recover')).catch(
      () => undefined,
    );
    _resetInFlightForTests(); /* simulate daemon restart: memory gone */
    expect(readPendingMarker('bs-recover')).not.toBeNull();
    mockRun.mockResolvedValueOnce(OK_RESULT);
    const r = await awaitPendingDistill(store, 'bs-recover', undefined, 5_000);
    expect(r.outcome).toBe('completed');
    expect(mockRun).toHaveBeenCalledTimes(2);
    const forced = mockRun.mock.calls[1]?.[1] as { reason: string };
    expect(forced.reason).toContain('cold-start-forced');
    expect(readPendingMarker('bs-recover')).toBeNull();
  });

  it('times out at the cap instead of hanging session start', async () => {
    mockRun.mockReturnValue(new Promise(() => undefined)); /* never resolves */
    void queueSessionEndPipeline(store, input('bs-hang')).catch(() => undefined);
    const started = Date.now();
    const r = await awaitPendingDistill(store, 'bs-hang', undefined, 200);
    expect(r.outcome).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('reports failed (not a hang) when the joined run rejects', async () => {
    let rejectRun: (e: unknown) => void = () => undefined;
    mockRun.mockReturnValue(new Promise((_, rj) => (rejectRun = rj)));
    void queueSessionEndPipeline(store, input('bs-rej')).catch(() => undefined);
    const gate = awaitPendingDistill(store, 'bs-rej', undefined, 5_000);
    rejectRun(new Error('llm exploded'));
    const r = await gate;
    expect(r.outcome).toBe('failed');
  });
});
