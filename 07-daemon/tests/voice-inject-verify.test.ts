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

/* Claude Code queues a prompt typed while the assistant is mid-turn
 * rather than submitting it. The queued prompt lands as a
 * queue-operation (operation:'enqueue', content:<payload>) and/or a
 * queued_command (prompt:<payload>) record - NOT a user record. These
 * are the shapes observed live in the bound session jsonl. */
function queueOperationLine(content: string, operation = 'enqueue'): string {
  return JSON.stringify({ type: 'queue-operation', operation, content }) + '\n';
}

function queuedCommandLine(prompt: string): string {
  return JSON.stringify({ type: 'queued_command', prompt }) + '\n';
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

/* ── SECONDARY (2026-07-18 VOICE-TOP-LAYER-SMARTS-SPEC): signal-based
 * false-stuck fix. When the deep PTY is busy mid-long-turn, the
 * injected prompt waits in the composer and cannot submit until the
 * turn ends. The fixed ~16s window used to false-fire the stuck banner
 * AND fire CR retries into a busy composer. Now: an assistant record
 * appearing in the bound jsonl this interval means the deep layer is
 * ACTIVELY producing (the prompt is queued, not stuck) - pause the
 * stuck clock, fire no CR. The timeout bounds TRUE SILENCE only; an
 * assistant-less silent stretch still recovers/fails exactly as before.
 * Mirrors the SM-15/17 signal-based liveness fix. */
describe('_verifyInjectDeliveryImpl signal-based busy-turn (SECONDARY)', () => {
  it('a busy deep turn (assistant records streaming) fires NO CR retry and confirms when the prompt finally submits', async () => {
    const rig = makeRig({
      onTick: (t) => {
        if (t <= 5) {
          rig.file.content += assistantRecordLine(
            `deep turn still producing chunk ${t}`,
          );
        } else if (t === 6) {
          rig.file.content += userRecordLine(
            '[voice mode] the operator words ride here after the long turn',
          );
        }
      },
    });
    const result = await _verifyInjectDeliveryImpl(rig.deps);
    expect(result).toBe('confirmed');
    /* No stray CR/Enter injected into the busy composer, no banner. */
    expect(rig.retries).toEqual([]);
    expect(rig.failures).toBe(0);
  });

  it('a long busy turn that never submits stops without a stuck banner (pending, no failure)', async () => {
    const rig = makeRig({
      onTick: () => {
        rig.file.content += assistantRecordLine('deep turn producing forever');
      },
    });
    rig.deps.maxWaitMs = 50; // interval 10 -> ~5 iterations then the wall
    const result = await _verifyInjectDeliveryImpl(rig.deps);
    expect(result).toBe('pending');
    expect(rig.retries).toEqual([]);
    expect(rig.failures).toBe(0);
  });

  it('a single stale assistant record does NOT permanently pause: silence after it still recovers via CR + fails', async () => {
    const rig = makeRig({
      onTick: (t) => {
        if (t === 1) {
          rig.file.content += assistantRecordLine('one chunk then silence');
        }
      },
    });
    const result = await _verifyInjectDeliveryImpl(rig.deps);
    expect(result).toBe('failed');
    /* The busy interval paused the clock once; the ensuing SILENCE
     * still escalates the full CR ladder and fails. */
    expect(rig.retries).toEqual([1, 2, 3]);
    expect(rig.failures).toBe(1);
  });
});

/* ── VB-3 (2026-07-18): a queued command is a DELIVERED prompt, not a
 * stuck paste. Live root cause: confirmed=1 vs failed=42. When Lex is
 * mid-turn the injected prompt is ACCEPTED into Claude Code's queue and
 * runs at the turn boundary - it lands as a queue-operation /
 * queued_command record carrying the fingerprint, never a user record
 * while busy. The verifier recognized only user records, so it counted
 * the queued prompt as silence, fired CR retries into the busy composer,
 * and raised the false 'voice error' banner. A genuinely stuck paste
 * writes NEITHER record (unsubmitted composer text), so the stuck-paste
 * failure path is preserved. */
describe('_verifyInjectDeliveryImpl queued-command recognition (VB-3)', () => {
  it('recognizes a queue-operation enqueue carrying the fingerprint as delivered: no CR retry, no failure', async () => {
    const rig = makeRig({
      onTick: (t) => {
        if (t === 1) {
          rig.file.content += queueOperationLine(
            '[voice mode] the operator words ride here (queued behind Lex mid-turn)',
          );
        }
      },
    });
    const result = await _verifyInjectDeliveryImpl(rig.deps);
    expect(result).toBe('queued');
    expect(rig.retries).toEqual([]);
    expect(rig.failures).toBe(0);
  });

  it('recognizes a queued_command (prompt field) carrying the fingerprint as delivered', async () => {
    const rig = makeRig({
      onTick: (t) => {
        if (t === 1) {
          rig.file.content += queuedCommandLine(
            'preamble the operator words ride here trailing',
          );
        }
      },
    });
    const result = await _verifyInjectDeliveryImpl(rig.deps);
    expect(result).toBe('queued');
    expect(rig.retries).toEqual([]);
    expect(rig.failures).toBe(0);
  });

  it('a busy-turn inject that queues (assistant streaming, then an enqueue record) never fires the false banner', async () => {
    /* The exact live shape: the deep layer streams assistant chunks
     * (mid-turn) and the injected prompt lands as an enqueue record,
     * not a user record. Pre-fix this false-failed with three CR
     * retries and the banner. */
    const rig = makeRig({
      onTick: (t) => {
        if (t <= 2) {
          rig.file.content += assistantRecordLine(`deep chunk ${t}`);
        } else if (t === 3) {
          rig.file.content += queueOperationLine(
            'the operator words ride here while Lex was busy',
          );
        }
      },
    });
    const result = await _verifyInjectDeliveryImpl(rig.deps);
    expect(result).toBe('queued');
    expect(rig.retries).toEqual([]);
    expect(rig.failures).toBe(0);
  });

  it('a non-enqueue queue-operation (dequeue/remove) is NOT treated as delivery: the stuck-paste path still runs', async () => {
    const rig = makeRig({
      onTick: (t) => {
        if (t === 1) {
          rig.file.content += queueOperationLine(
            'the operator words ride here',
            'dequeue',
          );
        }
      },
    });
    const result = await _verifyInjectDeliveryImpl(rig.deps);
    expect(result).toBe('failed');
    expect(rig.retries).toEqual([1, 2, 3]);
    expect(rig.failures).toBe(1);
  });

  it('a real user record still wins immediately (idle submit unaffected)', async () => {
    const rig = makeRig({
      onTick: (t) => {
        if (t === 1) {
          rig.file.content += userRecordLine(
            'plain the operator words ride here now',
          );
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

  it('a front-truncated landing that CARRIES the utterance confirms without repasting (2026-07-17 00:50Z duplicate-turn fix)', async () => {
    /* Live failure: both pastes landed front-truncated but with the
     * operator's words intact in the tail; the old verifier read
     * utterance+tail-without-head as "partial", repasted (Lex answered
     * the same utterance twice), then logged FAILED on a delivered
     * prompt. The utterance fingerprint IS the delivery signal: head
     * loss is context damage worth a loud log, never a repaste. */
    const rig = integrityRig({
      onTick: (t, r) => {
        if (t === 1) {
          r.file.content += userRecordLine(
            'context never ran.\n[voice mode] I was trying to figure out how your context got cleared when that pipeline to clear the brainstorming context never ran.',
          );
        }
      },
    });
    const logs: string[] = [];
    rig.deps.log = (m) => logs.push(m);
    const result = await _verifyInjectDeliveryImpl(rig.deps);
    expect(result).toBe('confirmed');
    expect(rig.state.repastes).toBe(0);
    expect(rig.retries).toEqual([]);
    expect(rig.state.failures).toBe(0);
    expect(logs.join(' ')).toContain('TRUNCATED DELIVERY');
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

  it('repaste fires at most once; persistent WORD-LESS partial landings exhaust into the loud failure', async () => {
    /* Only fragments that never carry the utterance may keep the
     * failure path: here every landing is a head-only fragment. */
    const rig = integrityRig({
      onTick: (_t, r) => {
        const fps = payloadIntegrityFingerprints(PAYLOAD);
        r.file.content += userRecordLine(`${fps.head} ...rest eaten`);
      },
    });
    const result = await _verifyInjectDeliveryImpl(rig.deps);
    expect(result).toBe('failed');
    expect(rig.state.repastes).toBe(1);
    expect(rig.state.failures).toBe(1);
  });

  it('a delivered prompt NEVER logs FAILED even when the repasted copy is also truncated', async () => {
    /* The exact 00:50Z sequence: paste 1 lands word-carrying but
     * headless; under the fixed contract it confirms immediately -
     * FAILED must be unreachable for delivered words. */
    const rig = integrityRig({
      onTick: (t, r) => {
        if (t === 1) {
          r.file.content += userRecordLine(
            '[voice mode] I was trying to figure out how your context got cleared when that pipeline to clear the brainstorming context never ran.',
          );
        }
      },
    });
    const result = await _verifyInjectDeliveryImpl(rig.deps);
    expect(result).toBe('confirmed');
    expect(rig.state.failures).toBe(0);
    expect(rig.state.repastes).toBe(0);
  });

  it('no record at all still walks the CR-retry path (integrity deps do not change the stuck-paste behavior)', async () => {
    const rig = integrityRig();
    const result = await _verifyInjectDeliveryImpl(rig.deps);
    expect(result).toBe('failed');
    expect(rig.retries).toEqual([1, 2, 3]);
    expect(rig.state.repastes).toBe(0);
  });
});

/* 2026-07-17 hotfix: a routine ws-close on the flaky pre-keepalive
 * build ran the TERMINAL session-end pipeline and flipped the live
 * brainstorm to status='ended'; every reconnect then bounced off the
 * bind gate. Disconnects flush only; terminal is explicit intent. */
describe('_sessionEndActionForReason', () => {
  it('ws-close is never terminal; explicit ends are', async () => {
    const { _sessionEndActionForReason } = await import(
      '../src/voice/lex-voice-ws.js'
    );
    expect(_sessionEndActionForReason('ws-close')).toBe('flush');
    expect(_sessionEndActionForReason('voice-command')).toBe('terminal');
    expect(_sessionEndActionForReason('compaction-restart')).toBe('terminal');
    expect(_sessionEndActionForReason('ui-end')).toBe('terminal');
  });
});
