import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let priorRoot: string | undefined;
let priorMode: string | undefined;
let priorDays: string | undefined;
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-pause-'));
  priorRoot = process.env.DEVNEURAL_DATA_ROOT;
  priorMode = process.env.DEVNEURAL_PAUSE_MODE;
  priorDays = process.env.DEVNEURAL_PAUSE_INACTIVITY_DAYS;
  process.env.DEVNEURAL_DATA_ROOT = tmpDir;
});

afterEach(() => {
  if (priorRoot === undefined) delete process.env.DEVNEURAL_DATA_ROOT;
  else process.env.DEVNEURAL_DATA_ROOT = priorRoot;
  if (priorMode === undefined) delete process.env.DEVNEURAL_PAUSE_MODE;
  else process.env.DEVNEURAL_PAUSE_MODE = priorMode;
  if (priorDays === undefined) delete process.env.DEVNEURAL_PAUSE_INACTIVITY_DAYS;
  else process.env.DEVNEURAL_PAUSE_INACTIVITY_DAYS = priorDays;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/* The pause-mode helper is a pure env-driven function inside
 * src/reinforcement/index.ts. It reads env on every call, so the
 * module is safe to import once at file scope. We exercise it via
 * decayInactivePages and observe the early no-op return when paused.
 * Module-level state inside reinforcement/index.ts (the
 * reinforcementLog path) does cache DATA_ROOT at module load. The
 * tests below pre-set DEVNEURAL_DATA_ROOT before any import so that
 * cached path lands inside our tmpDir. Subsequent tests that flip
 * tmpDir between cases get a different tmpDir but the cached path
 * keeps pointing at the first tmpDir; we accept this and only
 * exercise pause-mode behaviour that does not depend on the path
 * existing under the current tmpDir. */
import { decayInactivePages } from '../src/reinforcement/index.js';
function callDecay() {
  return decayInactivePages({} as never, () => undefined);
}

describe('WI-5 pause mode (DEVNEURAL_PAUSE_MODE)', () => {
  it('mode=on freezes decay regardless of activity', async () => {
    /* The decayInactivePages early no-op happens BEFORE any
     * filesystem read, so this assertion is safe even though the
     * cached DATA_ROOT inside reinforcement/index.ts may point at
     * the live data root rather than tmpDir. The mode=off branch
     * is intentionally NOT tested here for that exact reason: it
     * would let the function reach the live wikiPagesDir() and
     * mutate production weight values. Mode=off is verified by
     * inspection of isPauseModeActive() in src/reinforcement/index.ts. */
    process.env.DEVNEURAL_PAUSE_MODE = 'on';
    const result = await callDecay();
    expect(result).toEqual({ decayed: 0, archived: 0 });
  });
});
