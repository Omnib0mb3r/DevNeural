/**
 * Smart-clear vet gate (DRIVE-QUEUE 4C). Pins the gate between
 * investigator output and inject: a good reseed passes; empty, missing
 * verified-state, missing next, and transcript-dump reseeds are rejected
 * so the daemon never blind-injects.
 */
import { describe, expect, it } from 'vitest';
import { vetReseed, draftReseed, draftStoppingPoint } from '../src/lex/smart-clear.js';

const GOOD = [
  'Resume: DevNeural.',
  'Verified state: HEAD d401563 on master, working tree clean.',
  'Were doing: smart-clear vet gate.',
  'Next: wire the plan + confirm routes.',
  'Decisions in force: investigator assembles, Lex fires.',
  'This is a reseed, not the transcript - resume from here.',
].join('\n');

describe('vetReseed', () => {
  it('passes a well-formed reseed', () => {
    const r = vetReseed(GOOD);
    expect(r.ok).toBe(true);
    expect(r.issues).toEqual([]);
  });

  it('rejects an empty reseed', () => {
    expect(vetReseed('').ok).toBe(false);
    expect(vetReseed('   ').issues).toContain('empty reseed');
  });

  it('rejects a reseed with no verified state', () => {
    const r = vetReseed('Resume the project. Next: do the thing.');
    expect(r.ok).toBe(false);
    expect(r.issues.join(' ')).toMatch(/verified state/i);
  });

  it('rejects a reseed with no next step', () => {
    const r = vetReseed('Verified state: HEAD abc1234, working tree clean.');
    expect(r.ok).toBe(false);
    expect(r.issues.join(' ')).toMatch(/next/i);
  });

  it('rejects a dumped transcript (jsonl markers)', () => {
    const dump =
      'HEAD abc1234 next\n' +
      '{"type":"assistant","uuid":"x","message":{}}\n'.repeat(3);
    const r = vetReseed(dump);
    expect(r.ok).toBe(false);
    expect(r.issues.join(' ')).toMatch(/transcript/i);
  });

  it('rejects an over-long reseed (transcript-sized)', () => {
    const big = 'HEAD abc1234 next\n' + 'x'.repeat(5000);
    const r = vetReseed(big);
    expect(r.ok).toBe(false);
    expect(r.issues.join(' ')).toMatch(/too long/i);
  });

  it('vets the deterministic draft reseed as good', () => {
    const signals = {
      headSha: 'abc1234',
      branch: 'master',
      dirty: false,
      lastCommitSubject: 'feat: x',
    };
    const reseed = draftReseed({
      label: 'DevNeural',
      signals,
      stoppingPoint: draftStoppingPoint(signals),
      hints: { doing: 'the work', next: 'the next thing', decisions: ['a'] },
    });
    expect(vetReseed(reseed).ok).toBe(true);
  });
});
