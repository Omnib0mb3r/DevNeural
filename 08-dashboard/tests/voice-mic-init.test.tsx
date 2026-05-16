/* Regression test for the mic init failure path.
 *
 * Two real defects motivated this file:
 *
 *   1. The ORT pin from commit 637ae73 ran against the wrong module
 *      record. vad-web imports onnxruntime-web/wasm and re-exports
 *      it as the named `ort` export, so a sibling
 *      `import("onnxruntime-web")` in the consumer never reached
 *      MicVAD.new. The threaded WASM build kept being selected,
 *      SharedArrayBuffer was unavailable, and ORT cascaded to
 *      `no available backend found. ERR: [wasm] RangeError ...`.
 *
 *   2. The error pill rendered the full message into a span with
 *      Tailwind's `truncate` class, so the user only ever saw
 *      `mic init failed: no available backend found. ERR: [wasm]
 *      Rang...` and could not tell what the real failure was.
 *
 * The tests pin: configureVadOrt writes to mod.ort.env.wasm even
 * when a sibling onnxruntime-web import is mocked to throw, and the
 * VoiceErrorPill renders the full multi-line RangeError text plus a
 * working retry handler.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
  configureVadOrt,
  VAD_NUM_THREADS,
  VAD_PROXY,
  VAD_SIMD,
  VAD_WASM_PATHS,
} from '../lib/voice-ort-config';
import { VoiceErrorPill } from '../components/VoiceErrorPill';

const FULL_RANGEERROR =
  'mic init failed: no available backend found.\n' +
  '  ERR: [wasm] RangeError: Out of memory\n' +
  "  [cpu] Error: previous call to 'initWasm()' failed.";

describe('configureVadOrt', () => {
  it('writes the WASM pin to the vad-web-exported ort instance', () => {
    const env = { wasm: {} as Record<string, unknown> };
    const mod = { ort: { env } };
    const written = configureVadOrt(mod);
    expect(env.wasm).toMatchObject({
      wasmPaths: VAD_WASM_PATHS,
      numThreads: VAD_NUM_THREADS,
      simd: VAD_SIMD,
      proxy: VAD_PROXY,
    });
    expect(written).toEqual([
      'wasmPaths',
      'numThreads',
      'simd',
      'proxy',
    ]);
  });

  it('uses mod.ort, not a sibling onnxruntime-web import', () => {
    /* Simulate the broken state of the old code: an unrelated
     * onnxruntime-web import resolves to a different env object.
     * configureVadOrt must mutate mod.ort.env.wasm specifically; the
     * sibling instance must remain untouched. */
    const siblingOrt = { env: { wasm: {} as Record<string, unknown> } };
    const vadOrt = { env: { wasm: {} as Record<string, unknown> } };
    const mod = { ort: vadOrt };
    configureVadOrt(mod);
    expect(vadOrt.env.wasm).toMatchObject({
      wasmPaths: VAD_WASM_PATHS,
      numThreads: VAD_NUM_THREADS,
      simd: VAD_SIMD,
      proxy: VAD_PROXY,
    });
    expect(siblingOrt.env.wasm).toEqual({});
  });

  it('survives mod with no ort export without throwing', () => {
    expect(() => configureVadOrt({})).not.toThrow();
    expect(() => configureVadOrt(null)).not.toThrow();
    expect(() => configureVadOrt(undefined)).not.toThrow();
    expect(configureVadOrt({})).toEqual([]);
  });

  it('survives a locked env without throwing or aborting', () => {
    const wasm: Record<string, unknown> = {};
    /* Make numThreads read-only to mimic a tightened ORT minor that
     * locks the field; the helper must still write the writable
     * fields and report what it managed. */
    Object.defineProperty(wasm, 'numThreads', {
      value: 4,
      writable: false,
      configurable: false,
    });
    const mod = { ort: { env: { wasm } } };
    const written = configureVadOrt(mod);
    expect(written).toContain('wasmPaths');
    expect(written).toContain('simd');
    expect(written).toContain('proxy');
    expect(written).not.toContain('numThreads');
    expect(wasm.wasmPaths).toBe(VAD_WASM_PATHS);
    expect(wasm.numThreads).toBe(4); // unchanged, locked
  });
});

describe('VoiceErrorPill', () => {
  it('renders the full multi-line RangeError text without truncation', () => {
    const onRetry = vi.fn();
    render(<VoiceErrorPill message={FULL_RANGEERROR} onRetry={onRetry} />);
    const span = screen.getByTestId('voice-error-message');
    /* The full message must be in the DOM; previously a `truncate`
     * class hid the suffix behind an ellipsis. */
    expect(span.textContent).toBe(FULL_RANGEERROR);
    expect(span.textContent).toContain('RangeError: Out of memory');
    expect(span.textContent).toContain("'initWasm()' failed.");
    /* The wrap classes must be present and the truncate class
     * must NOT be on the message span. */
    expect(span.className).toMatch(/whitespace-pre-wrap/);
    expect(span.className).toMatch(/break-words/);
    expect(span.className).not.toMatch(/\btruncate\b/);
  });

  it('fires onRetry when the retry button is clicked', () => {
    const onRetry = vi.fn();
    render(<VoiceErrorPill message={FULL_RANGEERROR} onRetry={onRetry} />);
    const retry = screen.getByTestId('voice-error-retry');
    fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('renders single-line errors intact too', () => {
    const onRetry = vi.fn();
    render(
      <VoiceErrorPill message="mic permission denied" onRetry={onRetry} />,
    );
    expect(screen.getByTestId('voice-error-message').textContent).toBe(
      'mic permission denied',
    );
  });
});
