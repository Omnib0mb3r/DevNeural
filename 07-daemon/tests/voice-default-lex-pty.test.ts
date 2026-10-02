import { describe, expect, it } from 'vitest';
import { pickDefaultLexPty } from '../src/voice/lex-voice-ws.js';

/* 2026-10-02: the LEX-CAR app's hello names no brainstorm. With two
 * brainstorms open the daemon bound the car to the first PTY in the
 * map, not the one Michael had just started. */
const pty = (ptyId: string, cwd: string, startedAt: number, exited = false) => ({
  ptyId,
  cwd,
  startedAt,
  exited,
});

describe('pickDefaultLexPty', () => {
  it('picks the most recently started live brainstorm, not the first one listed', () => {
    const picked = pickDefaultLexPty([
      pty('old-peax', 'C:/dev/data/skill-connections/brainstorm', 1_000),
      pty('new-car', 'C:/dev/data/skill-connections/brainstorm', 5_000),
      pty('mid', 'C:/dev/data/skill-connections/brainstorm', 3_000),
    ]);
    expect(picked?.ptyId).toBe('new-car');
  });

  it('skips exited brainstorms, voice-layer and worker terminals', () => {
    const picked = pickDefaultLexPty([
      pty('lex', 'C:/dev/data/skill-connections/brainstorm', 1_000),
      pty('dead-newer', 'C:/dev/data/skill-connections/brainstorm', 9_000, true),
      pty('l1', 'C:/dev/data/skill-connections/voice-l1', 8_000),
      pty('worker', 'C:/dev/Projects/lex-car', 7_000),
    ]);
    expect(picked?.ptyId).toBe('lex');
  });

  it('returns undefined when no Lex is running', () => {
    expect(pickDefaultLexPty([pty('w', 'C:/dev/Projects/x', 1)])).toBeUndefined();
  });
});
