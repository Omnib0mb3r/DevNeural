import { describe, expect, it } from 'vitest';
import {
  classifyStopUtterance,
  truncateToHeard,
  decideInterruptPolicy,
} from '../src/voice/engine/interrupt-arbiter.js';

/**
 * Spec: stop-class utterances interrupt Lex's in-flight turn
 * immediately, never queue to a turn boundary. Deterministic, no LLM
 * round trip. On interrupt: context truncates to the words actually
 * heard; stop-playback and generate-response are independent, with a
 * policy step deciding rethink-versus-finish.
 *
 * Every phrase case below is from live transcripts (daemon.log
 * 2026-07-17 03:02-03:14Z) or the operator's spoken-control help doc.
 */
describe('classifyStopUtterance: deterministic stop-class detection', () => {
  it('bare "stop" hard-interrupts the work', () => {
    const r = classifyStopUtterance('Stop.');
    expect(r.stop).toBe('interrupt_work');
    expect(r.remainder).toBe('');
  });

  it('"shut up" / "be quiet" silence the voice only', () => {
    expect(classifyStopUtterance('shut up').stop).toBe('stop_speaking');
    expect(classifyStopUtterance('Be quiet!').stop).toBe('stop_speaking');
    expect(classifyStopUtterance('stop talking').stop).toBe('stop_speaking');
  });

  it('"hold on, stop what you\'re doing" hard-interrupts', () => {
    const r = classifyStopUtterance("hold on, stop what you're doing");
    expect(r.stop).toBe('interrupt_work');
  });

  it('a leading stop verb with substantive content interrupts AND forwards the content', () => {
    const r = classifyStopUtterance(
      'Stop making dumbass coding decisions like stupid short timers.',
    );
    expect(r.stop).toBe('interrupt_work');
    expect(r.remainder.toLowerCase()).toContain('making dumbass coding decisions');
  });

  it('"wait for the research." is content, not a stop (live 03:04:27Z)', () => {
    const r = classifyStopUtterance('wait for the research.');
    expect(r.stop).toBeNull();
    expect(r.remainder).toBe('wait for the research.');
  });

  it('bare "wait" / "hold on" are stops', () => {
    expect(classifyStopUtterance('wait').stop).toBe('interrupt_work');
    expect(classifyStopUtterance('Wait, wait, wait.').stop).toBe('interrupt_work');
    expect(classifyStopUtterance('hold on').stop).toBe('interrupt_work');
    expect(classifyStopUtterance('hold on a second').stop).toBe('interrupt_work');
  });

  it('"stop" mid-sentence never triggers', () => {
    const r = classifyStopUtterance('should we stop by the settings page next');
    expect(r.stop).toBeNull();
  });

  it('"cancel that" and "never mind" interrupt', () => {
    expect(classifyStopUtterance('cancel that').stop).toBe('interrupt_work');
    expect(classifyStopUtterance('never mind').stop).toBe('interrupt_work');
  });

  it('ordinary substantive turns pass through untouched', () => {
    const r = classifyStopUtterance(
      'And go do deep research to determine whether more work is needed.',
    );
    expect(r.stop).toBeNull();
    expect(r.remainder).toBe(
      'And go do deep research to determine whether more work is needed.',
    );
  });
});

describe('truncateToHeard: context reflects only what actually played', () => {
  const REPLY =
    'The daemon restarted cleanly and every scheduler came back up on the new build.';

  it('nothing played means nothing heard', () => {
    expect(truncateToHeard(REPLY, 0)).toBe('');
  });

  it('full playback returns the full text', () => {
    expect(truncateToHeard(REPLY, 600_000)).toBe(REPLY);
  });

  it('partial playback cuts on a word boundary, never mid-word', () => {
    const heard = truncateToHeard(REPLY, 2_000);
    expect(heard.length).toBeGreaterThan(0);
    expect(heard.length).toBeLessThan(REPLY.length);
    expect(REPLY.startsWith(heard)).toBe(true);
    expect(heard.endsWith(' ')).toBe(false);
    const nextChar = REPLY.charAt(heard.length);
    expect([' ', '']).toContain(nextChar);
  });

  it('longer playback hears more', () => {
    const a = truncateToHeard(REPLY, 1_000);
    const b = truncateToHeard(REPLY, 3_000);
    expect(b.length).toBeGreaterThan(a.length);
  });
});

describe('decideInterruptPolicy: rethink versus finish, decoupled from the stop', () => {
  it('stop-class drops the reply, no response generated', () => {
    expect(
      decideInterruptPolicy({ newText: 'stop', stop: 'interrupt_work' }),
    ).toBe('drop-reply');
    expect(
      decideInterruptPolicy({ newText: 'shut up', stop: 'stop_speaking' }),
    ).toBe('drop-reply');
  });

  it('a contradiction/redirect rethinks the in-flight answer', () => {
    expect(
      decideInterruptPolicy({
        newText: 'no, actually use the staging database instead',
        stop: null,
      }),
    ).toBe('rethink');
    expect(
      decideInterruptPolicy({
        newText: "that's wrong, the tests are failing",
        stop: null,
      }),
    ).toBe('rethink');
  });

  it('an unrelated aside finishes the thought first, then answers', () => {
    expect(
      decideInterruptPolicy({
        newText: 'also remind me to check the backups tomorrow',
        stop: null,
      }),
    ).toBe('finish-then-answer');
  });
});
