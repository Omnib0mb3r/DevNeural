import { beforeEach, describe, expect, it } from 'vitest';
import {
  readLastAssistantTurn,
  _seedDigestFromLastTurnImpl,
  _shouldReplayOnBindImpl,
  _replayLastTurnOnBindImpl,
  _recordReplyDelivery,
  _getReplyDelivery,
  _resetReplyDeliveryTracking,
  REPLAY_MAX_AGE_MS,
} from '../src/voice/lex-voice-ws.js';
import type { LexDigest } from '../src/voice/voice-digest.js';

/**
 * Item 2 (2026-07-09): switching to a session replays its last reply once
 * (recency-guarded) so you catch up on what you may have missed. This
 * pins the pure extraction: the newest assistant text block wins, tool
 * and user turns are skipped, and the mtime comes back for the caller's
 * recency window.
 */
const A = (uuid: string, text: string) =>
  JSON.stringify({
    type: 'assistant',
    uuid,
    message: { content: [{ type: 'text', text }], stop_reason: 'end_turn' },
  });
const U = (text: string) =>
  JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text }] } });

describe('readLastAssistantTurn', () => {
  it('returns the newest assistant reply and the file mtime', () => {
    const body = [A('a1', 'first reply'), U('a question'), A('a2', 'the latest reply')].join('\n');
    const out = readLastAssistantTurn('x.jsonl', {
      readTail: () => body,
      statMtimeMs: () => 1234,
    });
    expect(out?.text).toBe('the latest reply');
    expect(out?.uuid).toBe('a2');
    expect(out?.mtimeMs).toBe(1234);
  });

  it('skips a trailing user turn to find the last assistant reply', () => {
    const body = [A('a1', 'lex answer'), U('ok thanks')].join('\n');
    const out = readLastAssistantTurn('x.jsonl', { readTail: () => body, statMtimeMs: () => 1 });
    expect(out?.text).toBe('lex answer');
  });

  it('concatenates multiple text blocks in one assistant record', () => {
    const rec = JSON.stringify({
      type: 'assistant',
      uuid: 'a3',
      message: { content: [{ type: 'text', text: 'part one. ' }, { type: 'text', text: 'part two.' }] },
    });
    const out = readLastAssistantTurn('x.jsonl', { readTail: () => rec, statMtimeMs: () => 1 });
    expect(out?.text).toBe('part one. part two.');
  });

  it('tolerates a partial first line (tail read cut mid-record)', () => {
    const body = ['ent","message":{}}', A('a4', 'clean reply')].join('\n');
    const out = readLastAssistantTurn('x.jsonl', { readTail: () => body, statMtimeMs: () => 1 });
    expect(out?.text).toBe('clean reply');
  });

  it('returns null when there is no assistant text', () => {
    const out = readLastAssistantTurn('x.jsonl', {
      readTail: () => [U('just a user turn')].join('\n'),
      statMtimeMs: () => 1,
    });
    expect(out).toBeNull();
  });

  it('returns null when the file cannot be read', () => {
    expect(readLastAssistantTurn('x.jsonl', { readTail: () => null, statMtimeMs: () => 1 })).toBeNull();
  });
});

/**
 * Fast-lane cold-start-on-switch fix (2026-07-14). buildVoiceDigest only
 * pushes at end_turn boundaries, so right after a bind/switch the digest
 * is stale or absent until Lex's next reply and the fast lane degrades
 * (queues everything). _seedDigestFromLastTurnImpl seeds the digest from
 * the session's real last turn at bind time, reusing the same
 * readLastAssistantTurn extraction the replay-on-switch feature already
 * does. Pure + dependency-injected: no real WS, filesystem, or clock.
 */
describe('_seedDigestFromLastTurnImpl (fast-lane cold-start-on-switch fix)', () => {
  const digest = (over: Partial<LexDigest> = {}): LexDigest => ({
    currentTask: '',
    lastDecision: '',
    openQuestion: '',
    workerStatus: '',
    nextSteps: '',
    ...over,
  });

  it('seeds the digest and returns the fresh stamp when the last turn is recent', () => {
    const pushed: Array<{ digest: LexDigest; ms: number }> = [];
    const out = _seedDigestFromLastTurnImpl('x.jsonl', {
      readLastAssistantTurn: () => ({
        text: 'the migration landed, tests are green',
        mtimeMs: 1_000,
        uuid: 'a1',
      }),
      getDigest: () => null,
      pushDigest: (d, ms) => pushed.push({ digest: d, ms }),
      buildVoiceDigest: (text) => digest({ lastDecision: text }),
      now: () => 1_000 + 5_000, // 5s after the turn: within any window
      replayWindowMs: 8 * 60 * 1000,
    });
    expect(out).toBe(6_000);
    expect(pushed).toHaveLength(1);
    expect(pushed[0]!.ms).toBe(6_000);
    expect(pushed[0]!.digest.lastDecision).toBe(
      'the migration landed, tests are green',
    );
  });

  it('carries the prior digest forward into buildVoiceDigest (same contract as the turn-boundary push)', () => {
    const prior = digest({ currentTask: 'wiring the voice lane' });
    let seenPrev: LexDigest | null | undefined;
    _seedDigestFromLastTurnImpl('x.jsonl', {
      readLastAssistantTurn: () => ({ text: 'reply', mtimeMs: 0, uuid: null }),
      getDigest: () => ({ digest: prior, ms: 0 }),
      pushDigest: () => {},
      buildVoiceDigest: (_text, prev) => {
        seenPrev = prev;
        return digest();
      },
      now: () => 0,
    });
    expect(seenPrev).toBe(prior);
  });

  it('does not seed when there is no jsonl path', () => {
    let called = false;
    const out = _seedDigestFromLastTurnImpl(null, {
      readLastAssistantTurn: () => {
        called = true;
        return null;
      },
      getDigest: () => null,
      pushDigest: () => {
        throw new Error('must not push');
      },
      buildVoiceDigest: () => digest(),
    });
    expect(out).toBeNull();
    expect(called).toBe(false);
  });

  it('does not seed when there is no last assistant turn', () => {
    const out = _seedDigestFromLastTurnImpl('x.jsonl', {
      readLastAssistantTurn: () => null,
      getDigest: () => null,
      pushDigest: () => {
        throw new Error('must not push');
      },
      buildVoiceDigest: () => digest(),
    });
    expect(out).toBeNull();
  });

  it('does not seed when the last turn is older than the recency window (leaves the gate as before)', () => {
    const out = _seedDigestFromLastTurnImpl('x.jsonl', {
      readLastAssistantTurn: () => ({ text: 'old reply', mtimeMs: 0, uuid: null }),
      getDigest: () => null,
      pushDigest: () => {
        throw new Error('must not push');
      },
      buildVoiceDigest: () => digest(),
      now: () => 9 * 60 * 1000, // 9 minutes later
      replayWindowMs: 8 * 60 * 1000,
    });
    expect(out).toBeNull();
  });

  it('is best-effort: a read failure never throws, just leaves the gate untouched', () => {
    const out = _seedDigestFromLastTurnImpl('x.jsonl', {
      readLastAssistantTurn: () => {
        throw new Error('fs error');
      },
      getDigest: () => null,
      pushDigest: () => {},
      buildVoiceDigest: () => digest(),
    });
    expect(out).toBeNull();
  });
});

/**
 * Stale-replay gate (2026-07-16). Four replay-on-switch firings in one
 * night (04:33 age=2s, 04:39 age=76s, 04:48 age=43s, 04:59 age=93s):
 * the operator stop/started voice repeatedly and every reconnect
 * re-spoke the previous reply, including ones he had fully heard, up
 * to 93s stale ("why do you keep saying that"). The old gate was age
 * alone with an 8-MINUTE window and no notion of whether the reply had
 * already been delivered. New gate: age under ~10s AND the reply was
 * NOT fully delivered - the 3e37d8d delivered/cut/miss outcome is the
 * signal; replay only cut or miss (or no record at all: the reply
 * landed while no client was attached), never delivered.
 */
describe('_shouldReplayOnBindImpl (stale-replay gate)', () => {
  const TURN = { text: 'the reply body', mtimeMs: 100_000 };

  it('replays a fresh reply whose delivery was CUT mid-speech', () => {
    const d = _shouldReplayOnBindImpl({
      lastTurn: TURN,
      lastDelivery: { outcome: 'cut', ms: 100_500 },
      now: 103_000,
    });
    expect(d.replay).toBe(true);
  });

  it('replays a fresh reply whose delivery MISSED entirely', () => {
    const d = _shouldReplayOnBindImpl({
      lastTurn: TURN,
      lastDelivery: { outcome: 'miss', ms: 100_500 },
      now: 103_000,
    });
    expect(d.replay).toBe(true);
  });

  it('never replays a fully delivered reply, even seconds old (the 04:33Z age=2s firing)', () => {
    const d = _shouldReplayOnBindImpl({
      lastTurn: TURN,
      lastDelivery: { outcome: 'delivered', ms: 100_800 },
      now: 102_000,
    });
    expect(d.replay).toBe(false);
    expect(d.reason).toContain('delivered');
  });

  it('age gate: a 76s-old reply never replays regardless of outcome (the 04:39Z firing)', () => {
    const d = _shouldReplayOnBindImpl({
      lastTurn: TURN,
      lastDelivery: { outcome: 'cut', ms: 100_500 },
      now: TURN.mtimeMs + 76_000,
    });
    expect(d.replay).toBe(false);
    expect(d.reason).toContain('stale');
  });

  it('no delivery record within the window still replays (reply landed while no client was attached)', () => {
    const d = _shouldReplayOnBindImpl({
      lastTurn: TURN,
      lastDelivery: null,
      now: TURN.mtimeMs + 3_000,
    });
    expect(d.replay).toBe(true);
  });

  it('a delivery record that predates the turn is ignored (it covered the PREVIOUS reply)', () => {
    const d = _shouldReplayOnBindImpl({
      lastTurn: TURN,
      lastDelivery: { outcome: 'delivered', ms: 99_000 },
      now: TURN.mtimeMs + 3_000,
    });
    expect(d.replay).toBe(true);
  });

  it('no last turn never replays', () => {
    const d = _shouldReplayOnBindImpl({
      lastTurn: null,
      lastDelivery: null,
      now: 0,
    });
    expect(d.replay).toBe(false);
  });

  it('the default window is ~10s', () => {
    expect(REPLAY_MAX_AGE_MS).toBe(10_000);
    const inWindow = _shouldReplayOnBindImpl({
      lastTurn: TURN,
      lastDelivery: null,
      now: TURN.mtimeMs + 9_000,
    });
    const outOfWindow = _shouldReplayOnBindImpl({
      lastTurn: TURN,
      lastDelivery: null,
      now: TURN.mtimeMs + 11_000,
    });
    expect(inWindow.replay).toBe(true);
    expect(outOfWindow.replay).toBe(false);
  });
});

/**
 * Replay-repeat guard (2026-07-17, daemon.log 01:33Z). During a daemon
 * boot the dashboard ws flapped (connect -> close roughly every second)
 * and EVERY fresh socket re-spoke the same last reply: ages 5s, 6s, 7s,
 * 8s, 9s in the log, until the 10s staleness cap finally silenced it.
 * The operator heard Lex repeat himself in a loop. Root cause: the
 * replay itself never recorded a delivery, so the "no delivery record
 * (client was away)" branch stayed true across reconnects; the only
 * per-connection guard (replayedOnBind) dies with each socket. The
 * replay IS a delivery: it must stamp 'delivered' (before speak, so
 * overlapping reconnect races cannot double-speak) and the next bind
 * must skip with "already fully delivered".
 */
describe('_replayLastTurnOnBindImpl (replay-repeat guard)', () => {
  const TURN = { text: 'the reply body', mtimeMs: 100_000, uuid: 'a1' };

  const harness = () => {
    const deliveries = new Map<string, { outcome: string; ms: number }>();
    const calls: string[] = [];
    const spoken: string[] = [];
    const deps = {
      getDelivery: (key: string | null) =>
        key ? ((deliveries.get(key) as never) ?? null) : null,
      recordDelivery: (key: string | null, outcome: string, ms: number) => {
        calls.push(`record:${outcome}`);
        if (key) deliveries.set(key, { outcome, ms });
      },
      speak: (text: string) => {
        calls.push('speak');
        spoken.push(text);
      },
      log: () => {},
      now: () => TURN.mtimeMs + 3_000,
    };
    return { deliveries, calls, spoken, deps };
  };

  it('speaks the replay once and stamps it delivered', () => {
    const h = harness();
    const spoke = _replayLastTurnOnBindImpl('x.jsonl', TURN, 'bk', h.deps as never);
    expect(spoke).toBe(true);
    expect(h.spoken).toEqual(['the reply body']);
    expect(h.deliveries.get('x.jsonl')?.outcome).toBe('delivered');
  });

  it('a second bind moments later does NOT re-speak (the 01:33Z ws-flap loop)', () => {
    const h = harness();
    _replayLastTurnOnBindImpl('x.jsonl', TURN, 'bk', h.deps as never);
    const spokeAgain = _replayLastTurnOnBindImpl('x.jsonl', TURN, 'bk', h.deps as never);
    expect(spokeAgain).toBe(false);
    expect(h.spoken).toHaveLength(1);
  });

  it('stamps BEFORE speaking so an overlapping reconnect race cannot double-speak', () => {
    const h = harness();
    _replayLastTurnOnBindImpl('x.jsonl', TURN, 'bk', h.deps as never);
    expect(h.calls).toEqual(['record:delivered', 'speak']);
  });

  it('a cut delivery still replays once, then locks (existing cut-replay contract preserved)', () => {
    const h = harness();
    h.deliveries.set('x.jsonl', { outcome: 'cut', ms: TURN.mtimeMs + 500 });
    const spoke = _replayLastTurnOnBindImpl('x.jsonl', TURN, 'bk', h.deps as never);
    expect(spoke).toBe(true);
    const spokeAgain = _replayLastTurnOnBindImpl('x.jsonl', TURN, 'bk', h.deps as never);
    expect(spokeAgain).toBe(false);
    expect(h.spoken).toHaveLength(1);
  });

  it('a stale turn never speaks and never stamps', () => {
    const h = harness();
    const old = { ...TURN, mtimeMs: h.deps.now() - REPLAY_MAX_AGE_MS - 1_000 };
    const spoke = _replayLastTurnOnBindImpl('x.jsonl', old, 'bk', h.deps as never);
    expect(spoke).toBe(false);
    expect(h.calls).toEqual([]);
  });
});

describe('reply delivery tracking (module-level, survives reconnects)', () => {
  beforeEach(() => {
    _resetReplyDeliveryTracking();
  });

  it('records and returns the latest outcome per session key', () => {
    _recordReplyDelivery('a.jsonl', 'cut', 1_000);
    _recordReplyDelivery('a.jsonl', 'delivered', 2_000);
    _recordReplyDelivery('b.jsonl', 'miss', 3_000);
    expect(_getReplyDelivery('a.jsonl')).toEqual({
      outcome: 'delivered',
      ms: 2_000,
    });
    expect(_getReplyDelivery('b.jsonl')).toEqual({ outcome: 'miss', ms: 3_000 });
  });

  it('null keys are a no-op and unknown keys return null', () => {
    _recordReplyDelivery(null, 'delivered', 1_000);
    expect(_getReplyDelivery(null)).toBeNull();
    expect(_getReplyDelivery('never-seen.jsonl')).toBeNull();
  });
});
