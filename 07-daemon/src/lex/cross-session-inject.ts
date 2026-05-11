/**
 * Cross-session prompt injection (Wave 3 Lane B step 38 / LX-15).
 *
 * Allows an external caller (e.g. a second Claude Code window, a
 * cron script, or the mobile dashboard) to inject a prompt into a
 * named Lex PTY session without going through the voice WS pipeline.
 *
 * Auth model:
 *   The caller derives a short-lived HMAC token from the dashboard
 *   auth secret (same root as the session cookie) keyed on:
 *     HMAC-SHA256(secret, `${target_session}:${unix_minute}`)
 *   where unix_minute = Math.floor(Date.now() / 60_000).
 *   The watcher accepts tokens for unix_minute and unix_minute-1
 *   (up to ~2 minutes of clock skew tolerance).
 *
 *   Callers that share the host can read the auth secret directly from
 *   $DATA_ROOT/dashboard/auth.json (field "secret").  Remote callers
 *   should POST /auth/cross-session-token (GET not allowed; that would
 *   expose the secret in logs) with a valid dn_session cookie.
 *
 * Allowlist:
 *   DEVNEURAL_CROSS_SESSION_ALLOWLIST comma-separated list of session
 *   name prefixes that may be targeted.  Default: empty = allow all
 *   active PTYs.
 *
 * Audit:
 *   Every attempt (accepted or rejected) is written to the
 *   cross_session_injection_log table in index.db (migration 017).
 */

import * as crypto from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { getAuthSecret } from '../dashboard/auth.js';
import { ptyInject, listPtys } from '../dashboard/pty-host.js';
import type { IndexDb } from '../store/index-db.js';

/* Allowlist env var. Comma-separated name/id prefixes. Empty = allow all. */
const RAW_ALLOWLIST = process.env.DEVNEURAL_CROSS_SESSION_ALLOWLIST ?? '';
function getAllowlist(): string[] {
  return RAW_ALLOWLIST.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Derive the expected HMAC token for a given target_session and minute
 * offset (0 = current minute, -1 = previous minute for skew tolerance).
 */
function deriveToken(targetSession: string, minuteOffset: number = 0): string {
  const secret = getAuthSecret();
  const minute = Math.floor(Date.now() / 60_000) + minuteOffset;
  return crypto
    .createHmac('sha256', secret)
    .update(`${targetSession}:${minute}`)
    .digest('hex');
}

/**
 * Verify that the provided token matches either the current or the
 * previous unix-minute slot (2-minute window).
 */
function verifyToken(targetSession: string, token: string): boolean {
  if (!token) return false;
  /* timing-safe compare for both slots */
  const t0 = deriveToken(targetSession, 0);
  const t1 = deriveToken(targetSession, -1);
  const buf = Buffer.from(token, 'hex');
  const b0 = Buffer.from(t0, 'hex');
  const b1 = Buffer.from(t1, 'hex');
  if (buf.length !== 32) return false; /* sha256 = 32 bytes */
  return (
    crypto.timingSafeEqual(buf, b0) ||
    crypto.timingSafeEqual(buf, b1)
  );
}

export interface InjectRequest {
  /** PTY id or brainstorm session name to inject into. */
  target_session: string;
  /** HMAC token derived from auth secret + target_session + unix_minute. */
  token: string;
  /** Text to inject.  Max 4096 chars. */
  text: string;
  /** Optional caller label for audit log (e.g. 'cron', 'mobile-dashboard'). */
  caller_label?: string;
  /** If true, append \r to commit the line (default: true). */
  commit?: boolean;
}

export interface InjectResult {
  ok: boolean;
  decision: 'accepted' | 'rejected_auth' | 'rejected_allowlist' | 'rejected_pty';
  error?: string;
}

/**
 * Attempt a cross-session injection.  Always writes an audit row to db.
 * Never throws; errors are returned in InjectResult.
 */
export function crossSessionInject(
  req: InjectRequest,
  db: IndexDb,
): InjectResult {
  const { target_session, token, text, caller_label, commit = true } = req;
  const text_preview = text.slice(0, 120);
  const text_length = text.length;

  function audit(
    decision: InjectResult['decision'],
    reject_reason?: string,
  ): void {
    try {
      db.insertCrossSessionLog({
        id: randomUUID(),
        target_session,
        caller_label: caller_label ?? null,
        text_preview,
        text_length,
        decision,
        reject_reason: reject_reason ?? null,
        brainstorm_id: null,
      });
    } catch {
      /* db write failure must not affect the caller */
    }
  }

  /* 1. Token auth */
  if (!verifyToken(target_session, token)) {
    audit('rejected_auth', 'HMAC verification failed');
    return { ok: false, decision: 'rejected_auth', error: 'invalid token' };
  }

  /* 2. Allowlist check */
  const allowlist = getAllowlist();
  if (allowlist.length > 0) {
    const allowed = allowlist.some(
      (prefix) =>
        target_session.startsWith(prefix) ||
        target_session === prefix,
    );
    if (!allowed) {
      audit('rejected_allowlist', `"${target_session}" not in allowlist`);
      return {
        ok: false,
        decision: 'rejected_allowlist',
        error: `target_session "${target_session}" is not in the configured allowlist`,
      };
    }
  }

  /* 3. Find PTY */
  const ptys = listPtys();
  const live = ptys.find(
    (p) => !p.exited && (p.ptyId === target_session || p.sessionId === target_session),
  );
  if (!live) {
    audit('rejected_pty', `no live PTY for "${target_session}"`);
    return {
      ok: false,
      decision: 'rejected_pty',
      error: `no live PTY session matching "${target_session}"`,
    };
  }

  /* 4. Inject */
  const injectResult = ptyInject(live.ptyId, text, commit);
  if (!injectResult.ok) {
    const reason = (injectResult as { ok: false; error: string }).error;
    audit('rejected_pty', reason);
    return { ok: false, decision: 'rejected_pty', error: reason };
  }

  audit('accepted');
  return { ok: true, decision: 'accepted' };
}

/**
 * Generate a token for the current unix-minute.  Used by
 * POST /auth/cross-session-token so authenticated dashboard users can
 * get a short-lived token without reading auth.json directly.
 */
export function issueToken(targetSession: string): string {
  return deriveToken(targetSession, 0);
}
