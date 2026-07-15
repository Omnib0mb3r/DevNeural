/**
 * WP-H: spawn delivery feedback -- pollInjectResult + the marker/
 * result-file slug contract (projects-new.ts).
 *
 * Behavior tests inject readResultFile/sleep/now so they never touch
 * real disk or real timers, matching the 12s/250ms poll's math
 * without an actual 12s wait. The contract test (queueProjectBootstrap
 * writes a marker whose basename injectResultFile can derive the
 * result path from) DOES touch real disk under a temp DATA_ROOT,
 * mirroring the DATA_ROOT-isolation pattern used across this test
 * suite (see scan-and-register.test.ts / transcript-watcher-catchup
 * .test.ts) so nothing here can write into the real production data
 * root.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pollInjectResult, injectSlug, injectResultFile } from '../src/dashboard/projects-new.js';

describe('pollInjectResult (fake clock, no real disk / timers)', () => {
  function fakeClock(startMs = 0): { now: () => number; sleep: (ms: number) => Promise<void> } {
    let current = startMs;
    return {
      now: () => current,
      sleep: async (ms: number) => {
        current += ms;
      },
    };
  }

  it('returns confirmed as soon as a {ok:true} result file is readable', async () => {
    const clock = fakeClock();
    const result = await pollInjectResult('C:/dev/Projects/DevNeural', {
      now: clock.now,
      sleep: clock.sleep,
      readResultFile: () => JSON.stringify({ ok: true, at: '2026-07-14T00:00:00.000Z', workspace: 'C:/dev/Projects/DevNeural' }),
    });
    expect(result).toEqual({ delivery: 'confirmed' });
  });

  it('returns failed with the bridge error when the result file reports ok:false', async () => {
    const clock = fakeClock();
    const result = await pollInjectResult('C:/dev/Projects/DevNeural', {
      now: clock.now,
      sleep: clock.sleep,
      readResultFile: () =>
        JSON.stringify({ ok: false, error: 'no active terminal', at: '2026-07-14T00:00:00.000Z', workspace: 'x' }),
    });
    expect(result).toEqual({ delivery: 'failed', error: 'no active terminal' });
  });

  it('falls back to a generic error when ok:false ships no error detail', async () => {
    const clock = fakeClock();
    const result = await pollInjectResult('C:/dev/Projects/DevNeural', {
      now: clock.now,
      sleep: clock.sleep,
      readResultFile: () => JSON.stringify({ ok: false }),
    });
    expect(result.delivery).toBe('failed');
    expect(result.error).toBeTruthy();
  });

  it('returns unconfirmed once the timeout elapses with no result file', async () => {
    const clock = fakeClock();
    let reads = 0;
    const result = await pollInjectResult('C:/dev/Projects/DevNeural', {
      now: clock.now,
      sleep: clock.sleep,
      timeoutMs: 1000,
      intervalMs: 250,
      readResultFile: () => {
        reads += 1;
        return null;
      },
    });
    expect(result).toEqual({ delivery: 'unconfirmed' });
    // 0, 250, 500, 750, 1000 -> 5 reads before the deadline check wins.
    expect(reads).toBe(5);
  });

  it('retries past a torn/mid-write read (malformed JSON) instead of failing outright', async () => {
    const clock = fakeClock();
    let call = 0;
    const result = await pollInjectResult('C:/dev/Projects/DevNeural', {
      now: clock.now,
      sleep: clock.sleep,
      timeoutMs: 5000,
      intervalMs: 250,
      readResultFile: () => {
        call += 1;
        if (call === 1) return '{"ok": tr'; // torn write
        return JSON.stringify({ ok: true, at: 'x', workspace: 'x' });
      },
    });
    expect(result).toEqual({ delivery: 'confirmed' });
    expect(call).toBe(2);
  });
});

describe('injectSlug / injectResultFile / queueProjectBootstrap on-disk contract', () => {
  let tmpDir: string;
  let priorDataRoot: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    tmpDir = fs
      .mkdtempSync(path.join(os.tmpdir(), 'devneural-inject-slug-'))
      .replace(/\\/g, '/');
    priorDataRoot = process.env.DEVNEURAL_DATA_ROOT;
    process.env.DEVNEURAL_DATA_ROOT = tmpDir;
  });

  afterEach(() => {
    if (priorDataRoot === undefined) delete process.env.DEVNEURAL_DATA_ROOT;
    else process.env.DEVNEURAL_DATA_ROOT = priorDataRoot;
    vi.resetModules();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('injectResultFile names the sibling of the marker queueProjectBootstrap writes', async () => {
    const pathsMod = await import('../src/paths.js');
    expect(pathsMod.DATA_ROOT).toBe(tmpDir);

    const mod = await import('../src/dashboard/projects-new.js');
    const workspace = 'C:/dev/Projects/DevNeural';
    mod.queueProjectBootstrap(workspace, 'claude');

    const slug = mod.injectSlug(workspace);
    const markerFile = path.posix.join(
      tmpDir,
      'session-bridge',
      '.workspace-inject',
      `${slug}.json`,
    );
    expect(fs.existsSync(markerFile)).toBe(true);

    const resultFile = mod.injectResultFile(workspace);
    expect(resultFile).toBe(
      path.posix.join(tmpDir, 'session-bridge', '.workspace-inject', `${slug}.result.json`),
    );
    // Same directory, same basename stem as the marker -- this is the
    // contract the bridge's resultFileForClaim (09-bridge/src/
    // workspace-inject-result.ts) independently reconstructs from the
    // claimed marker's own path.
    expect(path.posix.dirname(resultFile)).toBe(path.posix.dirname(markerFile));
  });

  it('reads a real on-disk result file written by the bridge (no injected reader)', async () => {
    const pathsMod = await import('../src/paths.js');
    expect(pathsMod.DATA_ROOT).toBe(tmpDir);

    const mod = await import('../src/dashboard/projects-new.js');
    const workspace = 'C:/dev/Projects/DevNeural';
    const resultFile = mod.injectResultFile(workspace);
    fs.mkdirSync(path.posix.dirname(resultFile), { recursive: true });
    fs.writeFileSync(
      resultFile,
      JSON.stringify({
        ok: true,
        at: new Date().toISOString(),
        workspace,
      }),
      'utf-8',
    );

    // No readResultFile override -- exercises the real fs.readFileSync
    // default path end to end against the faked-on-disk result file.
    const delivery = await mod.pollInjectResult(workspace, {
      timeoutMs: 500,
      intervalMs: 50,
    });
    expect(delivery).toEqual({ delivery: 'confirmed' });
  });

  it('injectSlug is stable for the same workspace and differs across workspaces', () => {
    const a1 = injectSlug('C:/dev/Projects/DevNeural');
    const a2 = injectSlug('C:/dev/Projects/DevNeural');
    const b = injectSlug('C:/dev/Projects/OtherProject');
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
  });
});
