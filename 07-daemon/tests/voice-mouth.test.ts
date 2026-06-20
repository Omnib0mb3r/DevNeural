/**
 * Single mouth (pillar 3.1, sliver V1).
 *
 * Pins: flag-off passthrough (no enforcement, no shared state); flag-on
 * single holder (second acquire is null while held = two streams
 * structurally impossible); release frees; token-scoped release so a late
 * release can't free a newer holder.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  acquireMouth,
  isMouthHeld,
  mouthHolder,
  _resetMouth,
} from '../src/voice/voice-mouth.js';

let prior: string | undefined;

beforeEach(() => {
  prior = process.env.DEVNEURAL_VOICE_HAIKU;
  _resetMouth();
});

afterEach(() => {
  if (prior === undefined) delete process.env.DEVNEURAL_VOICE_HAIKU;
  else process.env.DEVNEURAL_VOICE_HAIKU = prior;
  _resetMouth();
});

describe('voice-mouth (flag OFF = passthrough)', () => {
  it('always grants and never records shared state when the tier is off', () => {
    delete process.env.DEVNEURAL_VOICE_HAIKU;
    const a = acquireMouth('A');
    const b = acquireMouth('B');
    expect(a).not.toBeNull();
    expect(b).not.toBeNull(); // both granted: no enforcement when off
    expect(isMouthHeld()).toBe(false); // no shared state touched
    a!.release();
    b!.release();
  });
});

describe('voice-mouth (flag ON = single mouth)', () => {
  beforeEach(() => {
    process.env.DEVNEURAL_VOICE_HAIKU = '1';
  });

  it('grants the first acquire and records the holder', () => {
    const a = acquireMouth('lex');
    expect(a).not.toBeNull();
    expect(isMouthHeld()).toBe(true);
    expect(mouthHolder()).toBe('lex');
  });

  it('a second acquire is null while held (two streams impossible)', () => {
    const a = acquireMouth('lex');
    const b = acquireMouth('heartbeat');
    expect(a).not.toBeNull();
    expect(b).toBeNull();
  });

  it('release frees the mouth for the next source', () => {
    const a = acquireMouth('lex')!;
    a.release();
    expect(isMouthHeld()).toBe(false);
    const b = acquireMouth('heartbeat');
    expect(b).not.toBeNull();
    expect(mouthHolder()).toBe('heartbeat');
  });

  it('token-scoped release: a late release cannot free a newer holder', () => {
    const a = acquireMouth('lex')!;
    a.release(); // frees
    const b = acquireMouth('heartbeat')!; // b now holds
    a.release(); // late/duplicate release from the old grant
    expect(isMouthHeld()).toBe(true); // b still holds
    expect(mouthHolder()).toBe('heartbeat');
    b.release();
    expect(isMouthHeld()).toBe(false);
  });
});
