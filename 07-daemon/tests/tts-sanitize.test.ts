/**
 * TTS sanitizer tests (Fix 59).
 *
 * Pins the rules that protect voice mode from leaking paths, URLs,
 * markup, and UUIDs into Piper synth.
 */
import { describe, expect, it } from 'vitest';
import { sanitizeForTts } from '../src/voice/tts-sanitize.js';

describe('sanitizeForTts', () => {
  it('returns empty string when input is empty or null-ish', () => {
    expect(sanitizeForTts('')).toBe('');
  });

  it('strips Windows absolute paths to the basename', () => {
    const out = sanitizeForTts(
      'see C:/dev/Projects/DevNeural/07-daemon/src/voice/piper.ts for details',
    );
    expect(out).toContain('piper.ts');
    expect(out).not.toContain('C:/dev/Projects/');
    expect(out).not.toContain('07-daemon/src/voice');
  });

  it('strips Windows backslash absolute paths to the basename', () => {
    const out = sanitizeForTts(
      'edit C:\\dev\\Projects\\DevNeural\\TODO.md before commit',
    );
    expect(out).toContain('TODO.md');
    expect(out).not.toContain('Projects');
  });

  it('strips POSIX absolute paths to the basename', () => {
    const out = sanitizeForTts('open /home/user/code/lex/main.py for review');
    expect(out).toContain('main.py');
    expect(out).not.toContain('/home/user');
  });

  it('reduces URLs to the host name', () => {
    const out = sanitizeForTts('see https://github.com/Omnib0mb3r/devneural for the repo');
    expect(out).toContain('github.com');
    expect(out).not.toContain('Omnib0mb3r');
    expect(out).not.toContain('https://');
  });

  it('handles URL with port and query string', () => {
    const out = sanitizeForTts('the dashboard at http://localhost:3000/system?tab=lex');
    expect(out).toContain('localhost');
    expect(out).not.toContain('3000');
    expect(out).not.toContain('?tab=lex');
  });

  it('replaces UUIDs with "opaque id"', () => {
    const out = sanitizeForTts(
      'bind anchor 4bbafb48-bbfd-47e6-b076-e1a58a334303 to project',
    );
    expect(out).toContain('opaque id');
    expect(out).not.toContain('4bbafb48-bbfd');
  });

  it('replaces long hex digests (SHA-style) with "opaque id"', () => {
    const out = sanitizeForTts(
      'commit a9779edabcdef0123456789abcdef0123456789ab lands the fix',
    );
    expect(out).toContain('opaque id');
    expect(out).not.toContain('a9779edabcdef');
  });

  it('leaves short hex tokens and small numbers alone', () => {
    const out = sanitizeForTts('Fix 47 lands commit abc123');
    expect(out).toContain('Fix 47');
    expect(out).toContain('abc123');
    expect(out).not.toContain('opaque id');
  });

  it('strips angle-bracket markup but keeps the surrounding prose', () => {
    const out = sanitizeForTts(
      'the <Button onClick={handler}>Click me</Button> opens the menu',
    );
    expect(out).toContain('Click me');
    expect(out).toContain('opens the menu');
    expect(out).not.toContain('<Button');
    expect(out).not.toContain('</Button>');
  });

  it('collapses runs of internal whitespace and trims trailing whitespace per line', () => {
    const out = sanitizeForTts('hello   world   \nnext line   ');
    expect(out).toBe('hello world\nnext line');
  });

  it('is idempotent: running twice yields identical output', () => {
    const dirty =
      'open C:/dev/Projects/DevNeural/FIXES.md and read https://example.com/api?x=1 for context';
    const once = sanitizeForTts(dirty);
    const twice = sanitizeForTts(once);
    expect(twice).toBe(once);
  });

  it('preserves natural speech text that contains no protected tokens', () => {
    const clean =
      'Right then. Two threads from yesterday. The dashboard bug and the wiki migration.';
    expect(sanitizeForTts(clean)).toBe(clean);
  });

  it('combines multiple rules in one pass', () => {
    const dirty =
      'cancel session 4bbafb48-bbfd-47e6-b076-e1a58a334303 in C:/dev/Projects/DevNeural and visit https://github.com/x';
    const out = sanitizeForTts(dirty);
    expect(out).toContain('opaque id');
    expect(out).toContain('github.com');
    expect(out).not.toContain('4bbafb48');
    expect(out).not.toContain('C:/dev');
    expect(out).not.toContain('https://');
  });
});
