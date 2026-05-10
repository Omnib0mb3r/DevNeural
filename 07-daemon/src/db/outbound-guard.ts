/**
 * Outbound guard (PB-2 + BF-4).
 *
 * Wraps every off-host call with three checks before the network
 * attempt:
 *
 *   1. Daily cap: refuse if today's call count or byte count would
 *      exceed DEVNEURAL_OUTBOUND_DAILY_CAP_CALLS / _BYTES (defaults
 *      200 calls / 5 MiB per spec section 6).
 *   2. Voice-session provenance: refuse if the payload class starts
 *      with 'brainstorm-' or 'meeting-' OR if the
 *      contains_voice_session_source flag is set. Defence-in-depth
 *      with the SQLite trigger (006-outbound-log.sql) and the
 *      cross-project verifier's source-page filter.
 *   3. Logging: every attempted call writes a row to outbound_log,
 *      even refused calls (failure_code records why).
 *
 * Callers pass a thunk that performs the actual network call. The
 * guard returns the thunk's result on success or throws an
 * OutboundRefused error on guard failure. Successful calls finalize
 * the log row with response_status; failed thunks finalize with
 * error message and failure_code='thunk_threw'.
 */
import { randomUUID } from 'node:crypto';
import type { IndexDb } from '../store/index-db.js';

export class OutboundRefused extends Error {
  constructor(
    public readonly failureCode: string,
    message: string,
  ) {
    super(message);
    this.name = 'OutboundRefused';
  }
}

export interface OutboundCall<T> {
  destination: string;
  purpose: string;
  /* Class enum (per spec section 7 outbound.md):
   *   wiki-page-candidate   - cross-project verifier or Pass 2 fallback payloads
   *   pass2-fallback        - Pass 2 schema retry
   *   heartbeat             - external heartbeat ping
   *   <other>               - free-form, must NOT start with 'brainstorm-' or 'meeting-'
   */
  payloadClass: string;
  payloadBytes: number;
  /* Set true when the payload's source provenance includes any voice
   * session content: source_brainstorms or source_meetings non-empty
   * on a wiki page, OR the payload itself is a brainstorm-* /
   * meeting-* class. The DB trigger is the third line of defence;
   * this flag is the first. */
  containsVoiceSessionSource: boolean;
  thunk: () => Promise<{ status: number; bodyBytes?: number } | T>;
}

const DEFAULT_CAP_CALLS = 200;
const DEFAULT_CAP_BYTES = 5 * 1024 * 1024;

function readCaps(): { calls: number; bytes: number } {
  const calls = Number(
    process.env.DEVNEURAL_OUTBOUND_DAILY_CAP_CALLS ?? DEFAULT_CAP_CALLS,
  );
  const bytes = Number(
    process.env.DEVNEURAL_OUTBOUND_DAILY_CAP_BYTES ?? DEFAULT_CAP_BYTES,
  );
  return {
    calls: Number.isFinite(calls) && calls > 0 ? calls : DEFAULT_CAP_CALLS,
    bytes: Number.isFinite(bytes) && bytes > 0 ? bytes : DEFAULT_CAP_BYTES,
  };
}

function isVoiceClass(cls: string): boolean {
  return cls.startsWith('brainstorm-') || cls.startsWith('meeting-');
}

export async function outboundCall<T>(
  db: IndexDb,
  call: OutboundCall<T>,
): Promise<T> {
  const id = randomUUID();
  const voiceFlag: 0 | 1 = call.containsVoiceSessionSource || isVoiceClass(call.payloadClass) ? 1 : 0;

  // Voice-session refusal must happen BEFORE the log write because
  // the SQLite trigger would otherwise abort the insert and leave
  // the caller without a meaningful error code.
  if (voiceFlag === 1) {
    throw new OutboundRefused(
      'voice-session-blocked',
      `outbound refused: payload_class='${call.payloadClass}' or voice-session-source=true`,
    );
  }

  // Daily cap check.
  const caps = readCaps();
  const usage = db.outboundTodayUsage();
  if (usage.calls + 1 > caps.calls) {
    db.insertOutboundLog({
      id,
      destination: call.destination,
      purpose: call.purpose,
      payload_class: call.payloadClass,
      contains_voice_session_source: 0,
      payload_bytes: call.payloadBytes,
    });
    db.finalizeOutboundLog(id, {
      failure_code: 'daily-cap-calls',
      error: `cap=${caps.calls} used=${usage.calls}`,
    });
    throw new OutboundRefused(
      'daily-cap-calls',
      `outbound cap reached: ${caps.calls} calls/day`,
    );
  }
  if (usage.bytes + call.payloadBytes > caps.bytes) {
    db.insertOutboundLog({
      id,
      destination: call.destination,
      purpose: call.purpose,
      payload_class: call.payloadClass,
      contains_voice_session_source: 0,
      payload_bytes: call.payloadBytes,
    });
    db.finalizeOutboundLog(id, {
      failure_code: 'daily-cap-bytes',
      error: `cap=${caps.bytes} used=${usage.bytes} request=${call.payloadBytes}`,
    });
    throw new OutboundRefused(
      'daily-cap-bytes',
      `outbound byte cap reached: ${caps.bytes}/day`,
    );
  }

  // Log the attempt before calling so that a thunk-thrown error
  // still leaves a row behind.
  db.insertOutboundLog({
    id,
    destination: call.destination,
    purpose: call.purpose,
    payload_class: call.payloadClass,
    contains_voice_session_source: 0,
    payload_bytes: call.payloadBytes,
  });

  try {
    const result = await call.thunk();
    const r = result as { status?: number };
    if (typeof r?.status === 'number') {
      db.finalizeOutboundLog(id, { response_status: r.status });
    } else {
      // Non-HTTP shape; record a synthetic 200 to mark success.
      db.finalizeOutboundLog(id, { response_status: 200 });
    }
    return result as T;
  } catch (err) {
    db.finalizeOutboundLog(id, {
      failure_code: 'thunk_threw',
      error: (err as Error).message,
    });
    throw err;
  }
}
