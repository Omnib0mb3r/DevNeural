/**
 * Voice->Lex delivery confirmation (2026-07-16 second wave).
 *
 * Live failure at 04:45Z: a committed voice inject sat at the Lex
 * terminal as unsubmitted [Pasted text #66-71] blocks - the trailing
 * CR was silently swallowed and nothing self-recovered; the operator
 * had to type characters and press Enter by hand. These tests pin
 * _verifyInjectDeliveryImpl: fingerprint confirmation against parsed
 * user records, CR retry escalation, and the loud failure path.
 */
import { describe, expect, it } from 'vitest';
import {
  _verifyInjectDeliveryImpl,
  type _VerifyInjectDeliveryDeps,
} from '../src/voice/lex-voice-ws.js';

function userRecordLine(text: string): string {
  return (
    JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'text', text }] },
    }) + '\n'
  );
}

function assistantRecordLine(text: string): string {
  return (
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text }] },
    }) + '\n'
  );
}

/* Mutable virtual jsonl + instant sleep. `onTick` runs before every
 * sleep so a test can land content at a chosen attempt boundary. */
function makeRig(opts?: { onTick?: (tick: number) => void }): {
  deps: _VerifyInjectDeliveryDeps;
  file: { content: string };
  retries: number[];
  failures: number;
} {
  const file = { content: '' };
  const retries: number[] = [];
  let failures = 0;
  let tick = 0;
  const deps: _VerifyInjectDeliveryDeps = {
    jsonlPath: 'C:/fake/lex-session.jsonl',
    startOffset: 0,
    fingerprint: 'the operator words ride here',
    statSize: () => Buffer.byteLength(file.content, 'utf-8'),
    readRange: (_p, start, length) =>
      Buffer.from(file.content, 'utf-8')
        .subarray(start, start + length)
        .toString('utf-8'),
    retryCr: (attempt) => retries.push(attempt),
    onFailure: () => {
      failures += 1;
    },
    sleep: async () => {
      tick += 1;
      opts?.onTick?.(tick);
    },
    log: () => undefined,
    intervalMs: 10,
    maxAttempts: 3,
  };
  return {
    deps,
    file,
    retries,
    get failures() {
      return failures;
    },
  } as ReturnType<typeof makeRig>;
}

describe('_verifyInjectDeliveryImpl', () => {
  it('confirms on a user record carrying the fingerprint, no retries', async () => {
    const rig = makeRig({
      onTick: (t) => {
        if (t === 1) {
          rig.file.content += userRecordLine(
            'live_state...\n[voice mode] the operator words ride here today',
          );
        }
      },
    });
    const result = await _verifyInjectDeliveryImpl(rig.deps);
    expect(result).toBe('confirmed');
    expect(rig.retries).toEqual([]);
    expect(rig.failures).toBe(0);
  });

  it('fires a CR retry when unconfirmed, then confirms once the record lands', async () => {
    const rig = makeRig({
      onTick: (t) => {
        if (t === 2) {
          rig.file.content += userRecordLine(
            '[voice mode] the operator words ride here after the nudge',
          );
        }
      },
    });
    const result = await _verifyInjectDeliveryImpl(rig.deps);
    expect(result).toBe('confirmed');
    expect(rig.retries).toEqual([1]);
    expect(rig.failures).toBe(0);
  });

  it('exhausts retries and fires the loud failure when nothing ever submits (the 04:45Z stuck paste)', async () => {
    const rig = makeRig();
    const result = await _verifyInjectDeliveryImpl(rig.deps);
    expect(result).toBe('failed');
    expect(rig.retries).toEqual([1, 2, 3]);
    expect(rig.failures).toBe(1);
  });

  it('matches through JSON escaping: a fingerprint with quotes still confirms', async () => {
    const rig = makeRig();
    rig.deps.fingerprint = 'he said "do it" and \\ moved on';
    rig.deps.sleep = (async () => {
      rig.file.content += userRecordLine(
        'prefix he said "do it" and \\ moved on suffix',
      );
    }) as _VerifyInjectDeliveryDeps['sleep'];
    const result = await _verifyInjectDeliveryImpl(rig.deps);
    expect(result).toBe('confirmed');
  });

  it('an assistant record echoing the fingerprint does NOT confirm (user records only)', async () => {
    const rig = makeRig({
      onTick: () => {
        if (rig.file.content === '') {
          rig.file.content += assistantRecordLine(
            'you said: the operator words ride here',
          );
        }
      },
    });
    const result = await _verifyInjectDeliveryImpl(rig.deps);
    expect(result).toBe('failed');
    expect(rig.retries).toEqual([1, 2, 3]);
  });

  it('short-circuits when there is no jsonl to verify against', async () => {
    const rig = makeRig();
    rig.deps.jsonlPath = null;
    const result = await _verifyInjectDeliveryImpl(rig.deps);
    expect(result).toBe('no-jsonl');
    expect(rig.retries).toEqual([]);
  });

  it('string-content user records (non-array message.content) also confirm', async () => {
    const rig = makeRig({
      onTick: (t) => {
        if (t === 1) {
          rig.file.content +=
            JSON.stringify({
              type: 'user',
              message: { content: 'plain the operator words ride here string' },
            }) + '\n';
        }
      },
    });
    const result = await _verifyInjectDeliveryImpl(rig.deps);
    expect(result).toBe('confirmed');
  });
});
