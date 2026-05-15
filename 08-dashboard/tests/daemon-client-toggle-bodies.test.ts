/**
 * Daemon-client toggle POST body regression test.
 *
 * The user reported the System Settings panel's Smart Compact and Lex
 * Cold Start Preload selectors "did nothing on click." Root cause was
 * a double-stringify in the daemon-client wrapper: callers like
 * setSmartCompactToggle pre-stringified their body with
 * JSON.stringify({mode}) and then request() ran JSON.stringify on
 * opts.body again. Fastify parsed the result into a STRING instead of
 * an object, body.mode came back undefined, the route 400-ed, and the
 * panel's optimistic-update rolled back. Visually: a no-op click.
 *
 * Fix was commit ad7291b -- callers now pass the raw object. This
 * test pins the wire shape so a future "let's pre-stringify again
 * to be explicit" refactor cannot quietly re-break the toggles.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  setSmartCompactToggle,
  setColdStartPreloadToggle,
} from '../lib/daemon-client';

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => {
    const body = JSON.stringify({
      ok: true,
      mode: 'live',
      runtime_value: 'live',
      env_value: null,
      default_mode: 'shadow',
    });
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('setSmartCompactToggle POST body shape', () => {
  it('sends {"mode":"live"} EXACTLY once (no double-stringify)', async () => {
    await setSmartCompactToggle('live');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/lex/smart-compact/toggle');
    expect((init as RequestInit).method).toBe('POST');
    /* The exact byte sequence the daemon's Fastify JSON parser must
     * receive. A double-encoded body would be the JSON-encoded
     * string '"{\\"mode\\":\\"live\\"}"' which would parse to a
     * string (not an object) and the route's body.mode access
     * returns undefined. */
    expect((init as RequestInit).body).toBe('{"mode":"live"}');
  });

  it('declares Content-Type: application/json so Fastify routes the body to the JSON parser', async () => {
    await setSmartCompactToggle('shadow');
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('switches modes correctly across off / shadow / live', async () => {
    await setSmartCompactToggle('off');
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({
      body: '{"mode":"off"}',
    });
    await setSmartCompactToggle('shadow');
    expect(fetchMock.mock.calls[1]![1]).toMatchObject({
      body: '{"mode":"shadow"}',
    });
  });
});

describe('setColdStartPreloadToggle POST body shape', () => {
  it('sends {"mode":"live"} EXACTLY once (no double-stringify)', async () => {
    await setColdStartPreloadToggle('live');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/lex/cold-start-preload/toggle');
    expect((init as RequestInit).method).toBe('POST');
    expect((init as RequestInit).body).toBe('{"mode":"live"}');
  });

  it('declares Content-Type: application/json so Fastify accepts the body', async () => {
    await setColdStartPreloadToggle('off');
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
  });
});

describe('regression: rejects the double-encoded shape', () => {
  it('the wire body must NOT be the JSON-encoded string form', async () => {
    /* If a future refactor reintroduces JSON.stringify({mode}) in
     * the caller, request() would stringify it again, and this
     * assertion would catch it: the wire body would be
     * '"{\\"mode\\":\\"live\\"}"', not '{"mode":"live"}'. */
    await setSmartCompactToggle('live');
    const body = fetchMock.mock.calls[0]![1]!.body as string;
    expect(body.startsWith('"')).toBe(false);
    expect(body.endsWith('}')).toBe(true);
    expect(JSON.parse(body)).toEqual({ mode: 'live' });
  });
});
