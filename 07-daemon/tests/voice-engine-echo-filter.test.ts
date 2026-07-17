import { describe, expect, it } from 'vitest';
import {
  createEchoRegistry,
  classifyEcho,
} from '../src/voice/engine/echo-filter.js';

/**
 * Spec (VOICE-TOP-LAYER-SPEC.md, echo second line): fuzzy-match whisper
 * transcripts against recent piper utterance text and discard matches.
 * Fuzzy, not exact, because whisper mangles. Live proof case: Lex spoke
 * "Cancelled call." and it came back minutes later as a queued user
 * utterance (2026-07-17). The filter is the daemon-side backstop behind
 * the HTMLAudioElement AEC fix; it must never eat a real operator turn.
 */
describe('echo-filter: fuzzy transcript-vs-TTS discard', () => {
  it('catches an exact echo of a spoken line', () => {
    const reg = createEchoRegistry();
    reg.remember('Cancelled call.', 1_000);
    const v = classifyEcho('cancelled call', reg, 3_000);
    expect(v.echo).toBe(true);
    expect(v.matched).toBe('Cancelled call.');
  });

  it('catches a whisper-mangled echo (token-level fuzz)', () => {
    const reg = createEchoRegistry();
    reg.remember('The migration landed, tests are green.', 1_000);
    const v = classifyEcho('the migration landed tests our green', reg, 4_000);
    expect(v.echo).toBe(true);
  });

  it('never suppresses a real operator turn that shares a few words', () => {
    const reg = createEchoRegistry();
    reg.remember(
      'I finished the migration and the tests are green across the board.',
      1_000,
    );
    const v = classifyEcho(
      'no stop the tests are wrong, roll the migration back',
      reg,
      2_500,
    );
    expect(v.echo).toBe(false);
  });

  it('catches a partial echo: a contiguous fragment of a longer reply', () => {
    const reg = createEchoRegistry();
    reg.remember(
      'The daemon restarted cleanly and every scheduler came back up on the new build.',
      1_000,
    );
    const v = classifyEcho('every scheduler came back up', reg, 3_000);
    expect(v.echo).toBe(true);
  });

  it('a single-word transcript is never suppressed (stop words must survive)', () => {
    const reg = createEchoRegistry();
    reg.remember('Stop me if this is wrong, but the plan is ready.', 1_000);
    const v = classifyEcho('stop', reg, 2_000);
    expect(v.echo).toBe(false);
  });

  it('entries expire: an old spoken line stops suppressing', () => {
    const reg = createEchoRegistry({ ttlMs: 10_000 });
    reg.remember('Cancelled call.', 1_000);
    const v = classifyEcho('cancelled call', reg, 60_000);
    expect(v.echo).toBe(false);
  });

  it('registry keeps only the newest N entries', () => {
    const reg = createEchoRegistry({ cap: 2 });
    reg.remember('the daemon restarted without any errors', 1_000);
    reg.remember('four wiki drafts landed from the ingest pass', 2_000);
    reg.remember('your reminder is set for nine tomorrow morning', 3_000);
    expect(
      classifyEcho('the daemon restarted without any errors', reg, 4_000).echo,
    ).toBe(false);
    expect(
      classifyEcho('your reminder is set for nine tomorrow morning', reg, 4_000)
        .echo,
    ).toBe(true);
  });
});
