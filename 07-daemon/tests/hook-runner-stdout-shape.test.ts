/**
 * SessionStart hook stdout shape pin.
 *
 * Claude Code's SessionStart hook protocol only auto-injects stdout
 * into the first user turn when the writer emits a JSON envelope with
 * `hookSpecificOutput.hookEventName='SessionStart'` plus an
 * `additionalContext` field. Plain markdown stdout is displayed but
 * dropped from the prompt context, which was the PRELOAD-1 regression
 * (cold-start preload route returned ok=true with a non-empty block
 * but Lex never saw it on the first turn).
 *
 * These pins assert the envelope shape on both SessionStart-time
 * writers in `hook-runner.ts`. Anything that re-introduces a bare
 * markdown write would fail these tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  postColdStartPreload,
  postWorkerHandoff,
} from '../src/capture/hooks/hook-runner.js';

const SENTINEL_BLOCK = '## sentinel preload block\n\nbody line one\n';

type StdoutWrite = typeof process.stdout.write;

let origFetch: typeof globalThis.fetch;
let origWrite: StdoutWrite;
let writes: string[];
let origPreloadFlag: string | undefined;
let origHandoffFlag: string | undefined;

beforeEach(() => {
  origFetch = globalThis.fetch;
  origWrite = process.stdout.write.bind(process.stdout) as StdoutWrite;
  writes = [];
  process.stdout.write = ((chunk: string | Uint8Array) => {
    writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
    return true;
  }) as StdoutWrite;
  origPreloadFlag = process.env.DEVNEURAL_LEX_COLD_START_PRELOAD_ENABLED;
  origHandoffFlag = process.env.DEVNEURAL_WORKER_HANDOFF_ENABLED;
  delete process.env.DEVNEURAL_LEX_COLD_START_PRELOAD_ENABLED;
  delete process.env.DEVNEURAL_WORKER_HANDOFF_ENABLED;
});

afterEach(() => {
  globalThis.fetch = origFetch;
  process.stdout.write = origWrite;
  if (origPreloadFlag === undefined) {
    delete process.env.DEVNEURAL_LEX_COLD_START_PRELOAD_ENABLED;
  } else {
    process.env.DEVNEURAL_LEX_COLD_START_PRELOAD_ENABLED = origPreloadFlag;
  }
  if (origHandoffFlag === undefined) {
    delete process.env.DEVNEURAL_WORKER_HANDOFF_ENABLED;
  } else {
    process.env.DEVNEURAL_WORKER_HANDOFF_ENABLED = origHandoffFlag;
  }
  vi.restoreAllMocks();
});

function stubOkFetch(): void {
  globalThis.fetch = (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, block: SENTINEL_BLOCK }),
    }) as unknown as Response) as typeof globalThis.fetch;
}

describe('postColdStartPreload stdout shape', () => {
  it('writes a SessionStart hookSpecificOutput envelope with the block as additionalContext', async () => {
    stubOkFetch();
    await postColdStartPreload('session-abc', 'C:/dev/Projects/Example');
    expect(writes.length).toBe(1);
    const parsed = JSON.parse(writes[0]!) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(parsed.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(parsed.hookSpecificOutput.additionalContext).toBe(SENTINEL_BLOCK);
  });
});

describe('postWorkerHandoff stdout shape', () => {
  it('writes a SessionStart hookSpecificOutput envelope with the block as additionalContext', async () => {
    stubOkFetch();
    await postWorkerHandoff('session-xyz', 'C:/dev/Projects/Example');
    expect(writes.length).toBe(1);
    const parsed = JSON.parse(writes[0]!) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(parsed.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(parsed.hookSpecificOutput.additionalContext).toBe(SENTINEL_BLOCK);
  });
});
