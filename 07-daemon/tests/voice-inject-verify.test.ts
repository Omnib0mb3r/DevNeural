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
  payloadIntegrityFingerprints,
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

/* ── content integrity (2026-07-16 third wave: FRONT truncation) ─────
 *
 * Three live losses tonight, all on the voice->Lex paste path, all
 * eating the LEADING content of the payload while the daemon-side
 * transcript stayed intact (~04:41Z mid-word lead loss; 04:54Z only
 * the tail fragment "...ood that?" landed out of 55 words; ~05:20Z
 * "context never ran.[voice mode]" sat at the prompt with the whole
 * lead eaten). Submission confirmation alone cannot catch these: the
 * truncated turn DOES produce a user record. These tests pin the
 * integrity extension: head + tail payload fingerprints, partial
 * landings trigger exactly one full repaste, and an intact landing
 * never repastes. */

const PAYLOAD = [
  'live_state: worker snapshot line that leads the payload',
  'aside: absorbed aside line',
  '[voice mode] I was trying to figure out how your context got cleared when that pipeline to clear the brainstorming context never ran.',
].join('\n');

function integrityRig(opts?: { onTick?: (tick: number, rig: IntegrityRig) => void }): IntegrityRig {
  const fps = payloadIntegrityFingerprints(PAYLOAD);
  const file = { content: '' };
  const retries: number[] = [];
  const state = { failures: 0, repastes: 0 };
  let tick = 0;
  const rig: IntegrityRig = {
    deps: {
      jsonlPath: 'C:/fake/lex-session.jsonl',
      startOffset: 0,
      fingerprint: 'I was trying to figure out how your context got cleared',
      headFingerprint: fps.head,
      tailFingerprint: fps.tail,
      repaste: () => {
        state.repastes += 1;
      },
      statSize: () => Buffer.byteLength(file.content, 'utf-8'),
      readRange: (_p, start, length) =>
        Buffer.from(file.content, 'utf-8')
          .subarray(start, start + length)
          .toString('utf-8'),
      retryCr: (attempt) => retries.push(attempt),
      onFailure: () => {
        state.failures += 1;
      },
      sleep: async () => {
        tick += 1;
        opts?.onTick?.(tick, rig);
      },
      log: () => undefined,
      intervalMs: 10,
      maxAttempts: 3,
    },
    file,
    retries,
    state,
  };
  return rig;
}

interface IntegrityRig {
  deps: _VerifyInjectDeliveryDeps;
  file: { content: string };
  retries: number[];
  state: { failures: number; repastes: number };
}

describe('payloadIntegrityFingerprints', () => {
  it('derives single-line head and tail probes that never cross newlines', () => {
    const fps = payloadIntegrityFingerprints(PAYLOAD);
    expect(fps.head).toBe(
      'live_state: worker snapshot line that leads the payload'.slice(0, 60),
    );
    expect(fps.head).not.toContain('\n');
    expect(fps.tail).not.toContain('\n');
    expect(PAYLOAD.split('\n')[2]!.endsWith(fps.tail)).toBe(true);
  });

  it('handles blank-padded and single-line payloads', () => {
    const fps = payloadIntegrityFingerprints('\n\n[voice mode] short\n\n');
    expect(fps.head).toBe('[voice mode] short');
    expect(fps.tail).toBe('[voice mode] short');
    const empty = payloadIntegrityFingerprints('   ');
    expect(empty.head).toBe('');
    expect(empty.tail).toBe('');
  });
});

describe('_verifyInjectDeliveryImpl content integrity', () => {
  it('an intact landing (head + tail + utterance) confirms with zero repastes', async () => {
    const rig = integrityRig({
      onTick: (t, r) => {
        if (t === 1) r.file.content += userRecordLine(PAYLOAD);
      },
    });
    const result = await _verifyInjectDeliveryImpl(rig.deps);
    expect(result).toBe('confirmed');
    expect(rig.state.repastes).toBe(0);
    expect(rig.retries).toEqual([]);
  });

  it('a front-truncated landing (head eaten, tail intact) triggers ONE repaste and then confirms', async () => {
    const rig = integrityRig({
      onTick: (t, r) => {
        if (t === 1) {
          /* The ~05:20Z shape: lead of the payload gone, tail survived. */
          r.file.content += userRecordLine(
            'context never ran.\n[voice mode] I was trying to figure out how your context got cleared when that pipeline to clear the brainstorming context never ran.',
          );
        }
        if (t === 2 && r.state.repastes === 1) {
          r.file.content += userRecordLine(PAYLOAD);
        }
      },
    });
    const result = await _verifyInjectDeliveryImpl(rig.deps);
    expect(result).toBe('confirmed');
    expect(rig.state.repastes).toBe(1);
    expect(rig.retries).toEqual([]);
  });

  it('total front loss leaving only a tail fragment still classifies partial and repastes (the 04:54Z shape)', async () => {
    const rig = integrityRig({
      onTick: (t, r) => {
        if (t === 1) {
          const fps = payloadIntegrityFingerprints(PAYLOAD);
          r.file.content += userRecordLine(`...ood that? ${fps.tail}`);
        }
        if (t === 2 && r.state.repastes === 1) {
          r.file.content += userRecordLine(PAYLOAD);
        }
      },
    });
    const result = await _verifyInjectDeliveryImpl(rig.deps);
    expect(result).toBe('confirmed');
    expect(rig.state.repastes).toBe(1);
  });

  it('repaste fires at most once; persistent partial landings exhaust into the loud failure', async () => {
    const rig = integrityRig({
      onTick: (_t, r) => {
        r.file.content += userRecordLine(
          '[voice mode] I was trying to figure out how your context got cleared but the head is gone',
        );
      },
    });
    const result = await _verifyInjectDeliveryImpl(rig.deps);
    expect(result).toBe('failed');
    expect(rig.state.repastes).toBe(1);
    expect(rig.state.failures).toBe(1);
  });

  it('no record at all still walks the CR-retry path (integrity deps do not change the stuck-paste behavior)', async () => {
    const rig = integrityRig();
    const result = await _verifyInjectDeliveryImpl(rig.deps);
    expect(result).toBe('failed');
    expect(rig.retries).toEqual([1, 2, 3]);
    expect(rig.state.repastes).toBe(0);
  });
});
