import { describe, expect, it } from 'vitest';
import {
  buildPtyInjectPayload,
  PTY_INJECT_COMMIT_NUDGE_MS,
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
