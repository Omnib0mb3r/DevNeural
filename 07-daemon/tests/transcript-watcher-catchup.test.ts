/**
 * Boot catch-up scan tests (task 3 of the capture-pipeline revival).
 *
 * The chokidar glob bug (see transcript-watcher-chokidar.test.ts) left the
 * watcher silently dead for ~65 days, so a fresh boot needs to drain
 * whatever backlog has accumulated on disk, bounded to files touched in
 * the last 90 days, sequentially, without re-processing files that are
 * already fully caught up.
 *
 * paths.ts's DATA_ROOT (and transcript-watcher.ts's own DEFAULT_ROOT) are
 * module-level consts resolved from process.env at import time. Static
 * top-level imports in this file would freeze DATA_ROOT before beforeEach
 * ever runs, which risks resolving to the REAL production data root
 * (C:/dev/data/skill-connections) instead of a temp dir. To avoid ever
 * writing test data into real user data, every test here sets the env
 * var, calls vi.resetModules(), and dynamically imports the module under
 * test -- then asserts DATA_ROOT actually landed on the temp dir before
 * doing anything that could write to disk.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Store } from '../src/store/index.js';

/** ingestTranscriptFile's signature wants a real Store, but its store
 * argument is only ever read behind `if (store)` guards inside
 * processFile. These tests care about the offset/cursor bookkeeping, not
 * embedding, so an untyped stand-in for "no store" keeps the call sites
 * honest about what they need. */
const NO_STORE = undefined as unknown as Store;

let tmpDir: string;
let root: string;

beforeEach(() => {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-tw-catchup-')).replace(/\\/g, '/');
  root = path.posix.join(tmpDir, 'home', '.claude', 'projects');
  fs.mkdirSync(root, { recursive: true });
  process.env.DEVNEURAL_DATA_ROOT = tmpDir;
});

afterEach(() => {
  delete process.env.DEVNEURAL_DATA_ROOT;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeJsonlLine(role: string, text: string, cwd: string): string {
  return JSON.stringify({
    role,
    message: { role, content: text },
    cwd,
    timestamp: new Date().toISOString(),
    uuid: `${role}-${Math.random().toString(16).slice(2)}`,
  });
}

describe('runTranscriptCatchupScan', () => {
  it('processes fresh files but skips files with no bytes past their cursor', async () => {
    const pathsMod = await import('../src/paths.js');
    // Safety gate: refuse to proceed against anything that isn't the temp
    // dir this test created. Would rather fail loudly than risk writing
    // into a real DATA_ROOT.
    expect(pathsMod.DATA_ROOT).toBe(tmpDir);

    const tw = await import('../src/capture/transcript-watcher.js');

    const slugDir = path.posix.join(root, 'proj-a');
    fs.mkdirSync(slugDir, { recursive: true });

    // A cwd that does not exist on disk: resolveProjectIdentity's first
    // check (`!fs.existsSync(cwd)`) short-circuits to the fixed 'global'
    // identity without shelling out to git, which keeps these tests fast
    // and deterministic instead of paying for 1-2 process spawns per file.
    const fakeCwd = path.posix.join(tmpDir, 'workspace-does-not-exist');

    const alreadyProcessedFile = path.posix.join(slugDir, 'session-a.jsonl');
    fs.writeFileSync(
      alreadyProcessedFile,
      writeJsonlLine('user', 'MSG_A_1', fakeCwd) + '\n',
      'utf-8',
    );
    // Pre-cache: process this file fully via the normal (exported)
    // ingest path, simulating "already caught up before this boot".
    const logLines: string[] = [];
    const firstPass = await tw.ingestTranscriptFile(alreadyProcessedFile, NO_STORE, (m) =>
      logLines.push(m),
    );
    expect(firstPass.bytes).toBeGreaterThan(0);

    const freshFile = path.posix.join(slugDir, 'session-b.jsonl');
    fs.writeFileSync(
      freshFile,
      writeJsonlLine('user', 'MSG_B_1', fakeCwd) + '\n',
      'utf-8',
    );

    const catchupLogs: string[] = [];
    await tw.runTranscriptCatchupScan(root, undefined, (m) => catchupLogs.push(m));

    const transcriptsPath = pathsMod.transcriptsFile('global');
    const contents = fs.readFileSync(transcriptsPath, 'utf-8');
    const linesWithA = contents.split('\n').filter((l) => l.includes('MSG_A_1'));
    const linesWithB = contents.split('\n').filter((l) => l.includes('MSG_B_1'));

    // Already-caught-up file: no duplicate re-processing.
    expect(linesWithA.length).toBe(1);
    // Fresh file: picked up by the catch-up scan exactly once.
    expect(linesWithB.length).toBe(1);

    expect(catchupLogs.some((l) => l.includes('catch-up: 1 file(s) with unprocessed bytes'))).toBe(
      true,
    );
  });

  it('ignores jsonl files older than the 90-day catch-up window', async () => {
    const pathsMod = await import('../src/paths.js');
    expect(pathsMod.DATA_ROOT).toBe(tmpDir);
    const tw = await import('../src/capture/transcript-watcher.js');

    const slugDir = path.posix.join(root, 'proj-old');
    fs.mkdirSync(slugDir, { recursive: true });
    const fakeCwd = path.posix.join(tmpDir, 'workspace-old-does-not-exist');

    const staleFile = path.posix.join(slugDir, 'session-old.jsonl');
    fs.writeFileSync(staleFile, writeJsonlLine('user', 'MSG_OLD_1', fakeCwd) + '\n', 'utf-8');
    const oldMtime = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000); // 120 days ago
    fs.utimesSync(staleFile, oldMtime, oldMtime);

    const catchupLogs: string[] = [];
    await tw.runTranscriptCatchupScan(root, undefined, (m) => catchupLogs.push(m));

    expect(catchupLogs.some((l) => l.includes('nothing pending'))).toBe(true);

    const transcriptsPath = pathsMod.transcriptsFile('global');
    expect(fs.existsSync(transcriptsPath)).toBe(false);
  });

  it('logs progress every 25 files during a large catch-up', async () => {
    const pathsMod = await import('../src/paths.js');
    expect(pathsMod.DATA_ROOT).toBe(tmpDir);
    const tw = await import('../src/capture/transcript-watcher.js');

    const slugDir = path.posix.join(root, 'proj-many');
    fs.mkdirSync(slugDir, { recursive: true });
    const fakeCwd = path.posix.join(tmpDir, 'workspace-many-does-not-exist');

    for (let i = 0; i < 26; i++) {
      const f = path.posix.join(slugDir, `session-${i}.jsonl`);
      fs.writeFileSync(f, writeJsonlLine('user', `MSG_MANY_${i}`, fakeCwd) + '\n', 'utf-8');
    }

    const catchupLogs: string[] = [];
    await tw.runTranscriptCatchupScan(root, undefined, (m) => catchupLogs.push(m));

    expect(catchupLogs.some((l) => l.includes('catch-up progress: 25/26 files'))).toBe(true);
  });
});
