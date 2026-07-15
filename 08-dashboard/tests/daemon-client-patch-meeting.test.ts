/**
 * patchMeeting wire-shape test (meeting-notes fixes 2026-07, task 4).
 *
 * Mirrors daemon-client-toggle-bodies.test.ts's regression shape: pin
 * the exact URL, method, and JSON body patchMeeting sends so a future
 * refactor cannot silently double-stringify the body (the bug class
 * that test file exists to guard against) or drop the PATCH method.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { patchMeeting } from '../lib/daemon-client';

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => {
    const body = JSON.stringify({ ok: true, meeting: { id: 'm1' } });
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

describe('patchMeeting PATCH body shape', () => {
  it('sends PATCH /meetings/:id with the exact JSON body, no double-stringify', async () => {
    await patchMeeting('m1', { attendees: 'alice, bob', meeting_topic: 'sync' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/meetings/m1');
    expect((init as RequestInit).method).toBe('PATCH');
    expect((init as RequestInit).body).toBe(
      '{"attendees":"alice, bob","meeting_topic":"sync"}',
    );
  });

  it('encodes the id into the URL', async () => {
    await patchMeeting('m/weird id', { attendees: 'x' });
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/meetings/m%2Fweird%20id');
  });

  it('sends null to explicitly clear a field (distinct from omitting it)', async () => {
    await patchMeeting('m1', { attendees: null });
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.body).toBe('{"attendees":null}');
  });

  it('declares Content-Type: application/json', async () => {
    await patchMeeting('m1', { meeting_topic: 'planning' });
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
  });
});
