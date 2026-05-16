/* Lex dashboard voice controls. Pins the contracts:
 *   1. Each kind sends the matching WS frame (voice-mute,
 *      voice-unmute, voice-disable) with the supplied reason.
 *   2. Broadcast (no bind_key) delivers to every non-closed client.
 *   3. Targeted (bind_key) delivers to exactly one client and skips
 *      everyone else.
 *   4. Targeted broadcast against an unknown bind_key resolves to
 *      delivered=0 (no client) rather than throwing.
 *   5. A socket whose send() throws does not abort the loop or
 *      block the remaining clients.
 *   6. Reason defaults to 'http-request' when omitted.
 *
 * Uses the test-only registry seam so the test never depends on
 * the real activeByBindKey map (which is owned by attachLexVoiceWs).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  _setVoiceControlRegistryForTests,
  broadcastVoiceControl,
} from '../src/voice/lex-voice-ws.js';

interface FakeSocket {
  ws: { send: (data: string) => void };
  closed: boolean;
  bindKey: string | null;
  sent: string[];
}

function fakeConn(bindKey: string | null, opts: { throwOnSend?: boolean } = {}): FakeSocket {
  const sent: string[] = [];
  return {
    ws: {
      send(data: string) {
        if (opts.throwOnSend) throw new Error('socket dead');
        sent.push(data);
      },
    },
    closed: false,
    bindKey,
    sent,
  };
}

function setRegistry(conns: Record<string, FakeSocket>): void {
  const m = new Map<
    string,
    { ws: { send: (data: string) => void }; closed: boolean; bindKey: string | null }
  >();
  for (const [key, c] of Object.entries(conns)) {
    m.set(key, { ws: c.ws, closed: c.closed, bindKey: c.bindKey });
  }
  _setVoiceControlRegistryForTests(m);
}

afterEach(() => {
  _setVoiceControlRegistryForTests(null);
});

describe('broadcastVoiceControl', () => {
  let a: FakeSocket;
  let b: FakeSocket;
  let c: FakeSocket;
  beforeEach(() => {
    a = fakeConn('anchor-a');
    b = fakeConn('anchor-b');
    c = fakeConn('anchor-c');
    setRegistry({ 'anchor-a': a, 'anchor-b': b, 'anchor-c': c });
  });

  it('mute broadcasts voice-mute to every active client', () => {
    const r = broadcastVoiceControl('mute', { reason: 'lex-tool' });
    expect(r).toMatchObject({ ok: true, delivered: 3, reason: 'lex-tool' });
    expect(r.bind_keys.sort()).toEqual(['anchor-a', 'anchor-b', 'anchor-c']);
    for (const conn of [a, b, c]) {
      expect(conn.sent.length).toBe(1);
      const parsed = JSON.parse(conn.sent[0]!);
      expect(parsed).toEqual({ t: 'voice-mute', reason: 'lex-tool' });
    }
  });

  it('unmute sends voice-unmute', () => {
    broadcastVoiceControl('unmute', { reason: 'tool' });
    expect(JSON.parse(a.sent[0]!)).toEqual({ t: 'voice-unmute', reason: 'tool' });
  });

  it('stop sends voice-disable (not session-end)', () => {
    /* Confirms /voice/stop maps to voice-disable. session-end would
     * tear down the brainstorm row, which is not what "stop the
     * voice session" means in the tool surface. */
    broadcastVoiceControl('stop', { reason: 'tool' });
    expect(JSON.parse(a.sent[0]!)).toEqual({ t: 'voice-disable', reason: 'tool' });
  });

  it('targeted bind_key delivers to exactly that connection', () => {
    const r = broadcastVoiceControl('mute', { bindKey: 'anchor-b', reason: 'targeted' });
    expect(r.delivered).toBe(1);
    expect(r.bind_keys).toEqual(['anchor-b']);
    expect(a.sent).toEqual([]);
    expect(b.sent.length).toBe(1);
    expect(c.sent).toEqual([]);
  });

  it('unknown bind_key returns delivered=0 without throwing', () => {
    const r = broadcastVoiceControl('mute', { bindKey: 'nope' });
    expect(r).toEqual({
      ok: true,
      delivered: 0,
      bind_keys: [],
      reason: 'http-request',
    });
    for (const conn of [a, b, c]) expect(conn.sent).toEqual([]);
  });

  it('skips closed connections during broadcast', () => {
    b.closed = true;
    setRegistry({ 'anchor-a': a, 'anchor-b': b, 'anchor-c': c });
    const r = broadcastVoiceControl('mute');
    expect(r.delivered).toBe(2);
    expect(r.bind_keys.sort()).toEqual(['anchor-a', 'anchor-c']);
    expect(b.sent).toEqual([]);
  });

  it('tolerates a single dead socket without aborting the broadcast', () => {
    const dead = fakeConn('anchor-dead', { throwOnSend: true });
    setRegistry({ 'anchor-a': a, 'anchor-dead': dead, 'anchor-c': c });
    const r = broadcastVoiceControl('mute', { reason: 'mixed' });
    /* delivered counts the survivors. The dead socket throws inside
     * send and is skipped silently per the broadcaster contract. */
    expect(r.delivered).toBe(2);
    expect(r.bind_keys.sort()).toEqual(['anchor-a', 'anchor-c']);
  });

  it('defaults reason to http-request when omitted', () => {
    broadcastVoiceControl('mute');
    expect(JSON.parse(a.sent[0]!)).toEqual({
      t: 'voice-mute',
      reason: 'http-request',
    });
  });
});
