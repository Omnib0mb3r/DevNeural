import { describe, expect, it } from 'vitest';
import {
  buildPtyInjectPayload,
  splitInjectPayloadIntoSlabs,
  PTY_INJECT_COMMIT_NUDGE_MS,
  PTY_INJECT_SLAB_CHARS,
} from '../src/dashboard/pty-host.js';

/**
 * Fix 19 (2026-05-23) regression: voice-mode inject missing CR.
 *
 * Symptom: voice STT utterances landed in the bound Claude Code PTY
 * as bracketed paste ("[Pasted text #N]") but the trailing Enter was
 * dropped, so the worker never processed the turn until the user
 * manually pressed Enter. Root cause: ptyInject wrote the body then
 * scheduled the \r 80ms later via setTimeout; the second pty.write
 * occasionally raced ahead of the first call's kernel flush so the
 * \r landed inside the bracketed-paste envelope and the TUI treated
 * it as part of the pasted text.
 *
 * Fix: assemble body + \r in a single string and hand it to the PTY
 * in one ordered pty.write. Mirrors the 09-bridge buildBridgePayload
 * fix for the bridge VSIX path.
 */
describe('buildPtyInjectPayload (Fix 19 regression)', () => {
  it('appends \\r atomically when commit=true so the CR cannot land mid-paste', () => {
    expect(buildPtyInjectPayload('hello', true)).toBe('hello\r');
  });

  it('ships the body alone when commit=false (suggest path parity)', () => {
    expect(buildPtyInjectPayload('hello', false)).toBe('hello');
  });

  it('preserves bracketed-paste envelope ordering: \\r sits AFTER the close terminator', () => {
    const wrapped = '\x1b[200~hello\x1b[201~';
    const out = buildPtyInjectPayload(wrapped, true);
    expect(out.endsWith('\x1b[201~\r')).toBe(true);
    expect(out.indexOf('\r')).toBe(out.length - 1);
  });

  it('handles multi-line bodies without splitting the CR off the tail', () => {
    const body = 'line one\nline two\nline three';
    expect(buildPtyInjectPayload(body, true)).toBe(`${body}\r`);
  });

  it('exposes a positive nudge interval so the belt-and-suspenders bare-\\r fires after the atomic write', () => {
    expect(PTY_INJECT_COMMIT_NUDGE_MS).toBeGreaterThan(0);
  });
});

/**
 * Large-inject truncation regression (2026-07-16 voice smoke test).
 *
 * A single pty.write of >4096 chars into interactive claude on Windows
 * ConPTY drops a whole 4096-char block (console input event queue
 * overflow). Live incident: the 03:27:08Z voice inject lost its
 * trailing chunk, so Lex received the live_state snapshot but not the
 * operator's utterance. Reproduced + fix verified against a real
 * claude PTY: 8937-char single write landed 4841 chars; the same
 * payload in 2048-char slabs landed complete.
 */
describe('splitInjectPayloadIntoSlabs (large-inject truncation regression)', () => {
  it('returns one slab, byte-identical, for payloads at or under the slab size (legacy path)', () => {
    const small = 'x'.repeat(PTY_INJECT_SLAB_CHARS);
    expect(splitInjectPayloadIntoSlabs(small)).toEqual([small]);
  });

  it('splits an oversized payload so no slab exceeds the slab size', () => {
    const payload = 'a'.repeat(PTY_INJECT_SLAB_CHARS * 4 + 371);
    const slabs = splitInjectPayloadIntoSlabs(payload);
    expect(slabs.length).toBe(5);
    for (const s of slabs) {
      expect(s.length).toBeLessThanOrEqual(PTY_INJECT_SLAB_CHARS);
    }
  });

  it('loses nothing: slab concatenation equals the original payload', () => {
    const payload = buildPtyInjectPayload(
      'line\n'.repeat(2500) + '[voice mode] the operator words ride the tail',
      true,
    );
    const slabs = splitInjectPayloadIntoSlabs(payload);
    expect(slabs.join('')).toBe(payload);
  });

  it('keeps the commit \\r on the FINAL slab so paste-close + Enter ordering (Fix 19) holds', () => {
    const payload = buildPtyInjectPayload('z'.repeat(9000), true);
    const slabs = splitInjectPayloadIntoSlabs(payload);
    expect(slabs[slabs.length - 1]!.endsWith('\r')).toBe(true);
    expect(slabs.slice(0, -1).some((s) => s.includes('\r'))).toBe(false);
  });
});
