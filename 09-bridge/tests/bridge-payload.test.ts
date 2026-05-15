/**
 * bridge-payload unit tests.
 *
 * Pins the 2026-05-14-bridge-inject-missing-enter fix: the bridge
 * MUST hand body + '\r' to terminal.sendText in a single atomic
 * call. The previous shape used two sendText calls separated by an
 * 80ms gap; that worked most of the time but raced intermittently
 * on a busy VS Code render frame, so the trailing '\r' occasionally
 * landed inside the bracketed-paste envelope and CC's TUI treated
 * it as part of the paste body. The doc captured a real instance:
 * a 642-char inject sat in the worker's input field for 52 minutes
 * until the user manually pressed Enter.
 *
 * Invariants the regression test must guarantee:
 *   - commit=true ALWAYS appends '\r' at the very end of the
 *     payload, after any bracketed-paste terminator.
 *   - commit=false NEVER appends '\r' so the user can review and
 *     submit themselves.
 *   - Multi-line and long payloads (> 200 chars) get the
 *     bracketed-paste envelope so embedded '\n' is not interpreted
 *     by the TUI as Enter.
 *   - Single-line short payloads skip the envelope.
 *   - The order of bytes in the final string is:
 *       (optional \x1b[200~) <body> (optional \x1b[201~) (optional \r)
 */
import { describe, expect, it } from 'vitest';
import {
  buildBridgePayload,
  needsBracketedPaste,
  wrapBracketedPaste,
  BRACKETED_PASTE_START,
  BRACKETED_PASTE_END,
} from '../src/bridge-payload.js';

describe('needsBracketedPaste', () => {
  it('returns true for any text containing a newline', () => {
    expect(needsBracketedPaste('line1\nline2')).toBe(true);
  });

  it('returns true for single-line text longer than the threshold', () => {
    expect(needsBracketedPaste('x'.repeat(201))).toBe(true);
  });

  it('returns false for short single-line text', () => {
    expect(needsBracketedPaste('hi')).toBe(false);
    expect(needsBracketedPaste('x'.repeat(200))).toBe(false);
  });
});

describe('wrapBracketedPaste', () => {
  it('wraps with the CSI 2004 start/end markers', () => {
    expect(wrapBracketedPaste('hello')).toBe(
      `${BRACKETED_PASTE_START}hello${BRACKETED_PASTE_END}`,
    );
  });
});

describe('buildBridgePayload commit=true', () => {
  it('appends \\r after a short single-line body', () => {
    const payload = buildBridgePayload('approve', true);
    expect(payload).toBe('approve\r');
    expect(payload.endsWith('\r')).toBe(true);
  });

  it('appends \\r OUTSIDE the bracketed-paste envelope for multi-line text', () => {
    const text = 'first\nsecond';
    const payload = buildBridgePayload(text, true);
    expect(payload).toBe(
      `${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}\r`,
    );
    /* The \r must appear AFTER the \x1b[201~ terminator. Inside the
     * envelope it would be treated as pasted text, not Enter -- which
     * was the exact failure mode of the previous two-sendText path. */
    const endIdx = payload.indexOf(BRACKETED_PASTE_END);
    const crIdx = payload.lastIndexOf('\r');
    expect(crIdx).toBeGreaterThan(endIdx);
  });

  it('appends \\r AT THE VERY END for long single-line payloads (> threshold)', () => {
    const long = 'x'.repeat(500);
    const payload = buildBridgePayload(long, true);
    expect(payload.endsWith('\r')).toBe(true);
    expect(payload.startsWith(BRACKETED_PASTE_START)).toBe(true);
    /* Sanity: the last non-\r byte is the close-paste sentinel,
     * not a body byte. */
    expect(
      payload.slice(payload.length - 1 - BRACKETED_PASTE_END.length, -1),
    ).toBe(BRACKETED_PASTE_END);
  });

  it('produces a single atomic string (no concatenation seams)', () => {
    /* This is the contract: the caller will hand the returned string
     * to terminal.sendText in ONE call. The function must not return
     * an array or require post-processing. */
    const payload = buildBridgePayload('hello\nworld', true);
    expect(typeof payload).toBe('string');
    expect(payload.length).toBeGreaterThan(0);
  });
});

describe('buildBridgePayload commit=false', () => {
  it('returns the body without a trailing \\r (suggest path)', () => {
    expect(buildBridgePayload('hello', false)).toBe('hello');
  });

  it('still wraps multi-line text in the bracketed-paste envelope', () => {
    /* commit=false is the curator's "suggestion" path: paste the
     * body but let the user review + submit. Bracketed paste is
     * still required so embedded \n doesn't accidentally commit. */
    const payload = buildBridgePayload('line1\nline2', false);
    expect(payload).toBe(
      `${BRACKETED_PASTE_START}line1\nline2${BRACKETED_PASTE_END}`,
    );
    expect(payload.endsWith('\r')).toBe(false);
  });
});

describe('regression: 2026-05-14-bridge-inject-missing-enter', () => {
  it('a 642-char multi-paragraph inject (the CREDITS payload shape) commits with a single \\r at the very end', () => {
    /* Loose proxy of the inject that stalled for 52 minutes per the
     * bug doc. Asserts: the build path produces a single string
     * ending in '\r' with paste markers in the right places, so the
     * VS Code sendText call delivers paste-body and Enter in one
     * atomic write. */
    const text =
      'Add CREDITS.md with third-party attributions:\n\n' +
      '- silero VAD model: MIT\n' +
      '- whisper.cpp: MIT\n' +
      '- piper TTS: MIT\n' +
      '- xterm.js: MIT\n' +
      '- node-pty: MIT\n' +
      '- ' + 'x'.repeat(400);
    expect(text.length).toBeGreaterThan(200);
    const payload = buildBridgePayload(text, true);
    expect(payload.startsWith(BRACKETED_PASTE_START)).toBe(true);
    expect(payload.endsWith(`${BRACKETED_PASTE_END}\r`)).toBe(true);
    /* Exactly one \r at the tail; no stray \r inside the body that
     * could have committed too early. */
    const tailCrMatches = payload.match(/\r/g) ?? [];
    expect(tailCrMatches.length).toBe(1);
  });
});
