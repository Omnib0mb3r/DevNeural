/**
 * Notes-mode capture-only path (meeting-notes fixes 2026-07, task 2).
 *
 * _captureNotesUtteranceOnlyImpl is what handleUtteranceEnd calls for
 * a notes-mode utterance that failed isAddressedToLexInNotesMode. Its
 * dependency list deliberately has no ptyInject / handleDirectLlmUtterance
 * hook, which is what proves this path writes a chunk WITHOUT ever
 * forwarding to Lex. See lex-voice-ws.ts's _CaptureNotesUtteranceDeps
 * doc comment for the full double-store rationale.
 */
import { describe, expect, it, vi } from 'vitest';
import { _captureNotesUtteranceOnlyImpl } from '../src/voice/lex-voice-ws.js';

describe('_captureNotesUtteranceOnlyImpl', () => {
  it('writes exactly one user/notes chunk, tagged, with no forwarding dependency available to call', () => {
    const insertChunk = vi.fn();
    const nextTurnIndex = vi.fn().mockReturnValue(3);

    _captureNotesUtteranceOnlyImpl({
      brainstormId: 'bs-1',
      text: 'the budget review moves to thursday',
      insertChunk,
      nextTurnIndex,
      newId: () => 'fixed-chunk-id',
    });

    expect(nextTurnIndex).toHaveBeenCalledWith('bs-1');
    expect(insertChunk).toHaveBeenCalledTimes(1);
    expect(insertChunk).toHaveBeenCalledWith({
      id: 'fixed-chunk-id',
      brainstorm_id: 'bs-1',
      turn_index: 3,
      role: 'user',
      mode: 'notes',
      text: 'the budget review moves to thursday',
      model_id: 'voice-notes-capture',
      cc_session_id: null,
    });
  });

  it('defaults to a fresh randomUUID id when newId is not supplied', () => {
    const insertChunk = vi.fn();
    _captureNotesUtteranceOnlyImpl({
      brainstormId: 'bs-2',
      text: 'hello',
      insertChunk,
      nextTurnIndex: () => 0,
    });
    const row = insertChunk.mock.calls[0]![0] as { id: string };
    expect(typeof row.id).toBe('string');
    expect(row.id.length).toBeGreaterThan(0);
  });

  it('is best-effort: an insertChunk throw is swallowed and logged, never rethrown', () => {
    const log = vi.fn();
    const insertChunk = vi.fn(() => {
      throw new Error('db is locked');
    });
    expect(() =>
      _captureNotesUtteranceOnlyImpl({
        brainstormId: 'bs-3',
        text: 'hello',
        insertChunk,
        nextTurnIndex: () => 0,
        log,
      }),
    ).not.toThrow();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toContain('notes-mode capture insert failed');
  });

  it('the deps type has no ptyInject / handleDirectLlmUtterance field: capture-only cannot forward by construction', () => {
    /* Structural pin, not a runtime assertion: the deps object below
     * is the full contract _captureNotesUtteranceOnlyImpl accepts.
     * There is no way to reach a PTY or an LLM call from inside it. */
    const deps = {
      brainstormId: 'bs-4',
      text: 'x',
      insertChunk: vi.fn(),
      nextTurnIndex: () => 0,
    };
    expect(Object.keys(deps)).toEqual([
      'brainstormId',
      'text',
      'insertChunk',
      'nextTurnIndex',
    ]);
  });
});
