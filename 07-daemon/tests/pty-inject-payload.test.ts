import { describe, expect, it } from 'vitest';
import {
  buildPtyInjectPayload,
  planPtyInjectWrites,
  splitInjectPayloadIntoSlabs,
  PTY_INJECT_COMMIT_NUDGE_MS,
  PTY_INJECT_SLAB_CHARS,
  PTY_INJECT_SLAB_SETTLE_MS,
  PTY_INJECT_WORDS_SETTLE_MS,
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
 * BUG-059 (2026-09-30): Claude Code v2.1.277+ treats a fast burst as a
 * paste and strips a \r riding inside it ("Removed 1 invisible
 * character · review and press Enter to send"); a bare \r at +1s or +3s
 * does not release the held line. Reproduced against a real claude PTY
 * with a 118-char single-line typed message: text+\r in one write held;
 * text, then \r as its own write 250ms later, submitted. Every commit
 * therefore sends the CR as its own write after the settle gap, the
 * shape the multi-slab path already used.
 */
describe('planPtyInjectWrites (BUG-059 held paste)', () => {
  it('never puts the commit \\r in the same write as the text, even for a one-slab message', () => {
    const plan = planPtyInjectWrites('Go look here Scrapling its a repo, see if its safe', true);
    const body = plan.filter((w) => w.data !== '\r');
    expect(body.every((w) => !w.data.includes('\r'))).toBe(true);
    expect(body.map((w) => w.data).join('')).toBe(
      'Go look here Scrapling its a repo, see if its safe',
    );
  });

  it('sends the commit \\r alone, at least the settle gap after the last text write', () => {
    const plan = planPtyInjectWrites('x'.repeat(5000), true);
    const lastText = Math.max(...plan.filter((w) => w.data !== '\r').map((w) => w.atMs));
    const crs = plan.filter((w) => w.data === '\r');
    expect(crs.length).toBe(2);
    expect(crs[0]!.atMs - lastText).toBeGreaterThanOrEqual(PTY_INJECT_SLAB_SETTLE_MS);
    expect(crs[1]!.atMs).toBeGreaterThan(crs[0]!.atMs);
  });

  it('BUG-065: with context, types the operator words alone first and the context as a later burst, then Enter', () => {
    const words = '[voice mode] read the docs and get caught up';
    const context = 'L'.repeat(8000);
    const plan = planPtyInjectWrites(words, true, context);
    expect(plan[0]).toEqual({ data: words, atMs: 0 });
    const ctx = plan.filter((w) => w.data !== '\r' && w !== plan[0]);
    expect(ctx.map((w) => w.data).join('')).toBe(`\n\n${context}`);
    expect(ctx[0]!.atMs).toBeGreaterThanOrEqual(PTY_INJECT_WORDS_SETTLE_MS);
    const crs = plan.filter((w) => w.data === '\r');
    expect(crs.length).toBe(2);
    expect(crs[0]!.atMs - ctx[ctx.length - 1]!.atMs).toBeGreaterThanOrEqual(PTY_INJECT_SLAB_SETTLE_MS);
  });

  it('starts with the text at 0ms and sends no \\r at all when commit=false', () => {
    const plan = planPtyInjectWrites('hello', false);
    expect(plan).toEqual([{ data: 'hello', atMs: 0 }]);
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

  it('slabs are built from the TEXT so no slab ever carries the commit \\r (2026-07-16 correction: an embedded final-slab CR was absorbed as paste content and the prompt sat unsubmitted)', () => {
    /* ptyInject slabs the raw text and fires the commit \r as its own
     * write PTY_INJECT_SLAB_SETTLE_MS after the final slab. Pin the
     * pure parts: text-splitting stays CR-free and the settle constant
     * leaves room for the paste burst to close before Enter. */
    const text = 'z'.repeat(9000);
    const slabs = splitInjectPayloadIntoSlabs(text);
    expect(slabs.some((s) => s.includes('\r'))).toBe(false);
    expect(slabs.join('')).toBe(text);
    expect(PTY_INJECT_SLAB_SETTLE_MS).toBeGreaterThanOrEqual(100);
  });
});
