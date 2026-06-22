/**
 * Smart-clear trail-confirm (DRIVE-QUEUE 4D). Pins the after-vet step: Lex
 * trails the worker's NEW jsonl to confirm it resumed on task (reseed
 * landed as a user turn AND the worker replied), vs swallowed inject or
 * no reply.
 */
import { describe, expect, it } from 'vitest';
import { confirmResumeOnTask } from '../src/lex/smart-clear.js';

const RESEED = [
  'Resume: DevNeural.',
  'Verified state: HEAD abc1234 on master, working tree clean.',
  'Next: wire the trail.',
].join('\n');

function jsonl(lines: object[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n');
}

describe('confirmResumeOnTask', () => {
  it('on-task when the reseed landed and the worker replied', () => {
    const body = jsonl([
      { type: 'user', message: { content: 'Resume: DevNeural. HEAD abc1234 ...' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'On it, resuming.' }] } },
    ]);
    const r = confirmResumeOnTask({
      newJsonl: '/new.jsonl',
      reseed: RESEED,
      readFile: () => body,
    });
    expect(r.onTask).toBe(true);
    expect(r.sawReseedEcho).toBe(true);
    expect(r.sawAssistant).toBe(true);
  });

  it('not on-task when the reseed never appears (inject swallowed)', () => {
    const body = jsonl([
      { type: 'user', message: { content: 'hello there' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } },
    ]);
    const r = confirmResumeOnTask({
      newJsonl: '/new.jsonl',
      reseed: RESEED,
      readFile: () => body,
    });
    expect(r.onTask).toBe(false);
    expect(r.sawReseedEcho).toBe(false);
    expect(r.reason).toMatch(/swallowed|not found/i);
  });

  it('not on-task when the reseed landed but no reply yet', () => {
    const body = jsonl([
      { type: 'user', message: { content: 'HEAD abc1234 resume now' } },
    ]);
    const r = confirmResumeOnTask({
      newJsonl: '/new.jsonl',
      reseed: RESEED,
      readFile: () => body,
    });
    expect(r.onTask).toBe(false);
    expect(r.sawReseedEcho).toBe(true);
    expect(r.sawAssistant).toBe(false);
  });

  it('handles an unreadable / empty new jsonl', () => {
    const r = confirmResumeOnTask({
      newJsonl: '/missing.jsonl',
      reseed: RESEED,
      readFile: () => null,
    });
    expect(r.onTask).toBe(false);
    expect(r.reason).toMatch(/unreadable|empty/i);
  });
});
