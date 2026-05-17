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
import { getAuthSecret } from '../dashboard/auth-secret.js';
import { ptyInject, listPtys } from '../dashboard/pty-host.js';
import { queueSessionPrompt, queueSessionSuggestion } from '../dashboard/sessions.js';
import type { IndexDb } from '../store/index-db.js';

/* Allowlist env var. Comma-separated name/id prefixes. Empty = allow all. */
const RAW_ALLOWLIST = process.env.DEVNEURAL_CROSS_SESSION_ALLOWLIST ?? '';
function getAllowlist(): string[] {
  return RAW_ALLOWLIST.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Derive the expected HMAC token for a given signing subject and
 * minute offset (0 = current minute, -1 = previous minute for skew
 * tolerance). Subject may be either a session uuid (legacy) or an
 * anchor id (Fix 15 alternate path); both share the same scheme.
 */
function deriveToken(subject: string, minuteOffset: number = 0): string {
  const secret = getAuthSecret();
  const minute = Math.floor(Date.now() / 60_000) + minuteOffset;
  return crypto
    .createHmac('sha256', secret)
    .update(`${subject}:${minute}`)
    .digest('hex');
}

/**
 * Verify that the provided token matches either the current or the
 * previous unix-minute slot (2-minute window) against one or more
 * acceptable signing subjects. Any subject matching against any slot
 * accepts the request. Subjects with empty/falsy values are skipped.
 */
function verifyToken(subjects: string[], token: string): boolean {
  if (!token) return false;
  const buf = Buffer.from(token, 'hex');
  if (buf.length !== 32) return false; /* sha256 = 32 bytes */
  for (const subject of subjects) {
    if (!subject) continue;
    const t0 = deriveToken(subject, 0);
    const t1 = deriveToken(subject, -1);
    const b0 = Buffer.from(t0, 'hex');
    const b1 = Buffer.from(t1, 'hex');
    if (
      crypto.timingSafeEqual(buf, b0) ||
      crypto.timingSafeEqual(buf, b1)
    ) {
      return true;
    }
  }
  return false;
}

export interface InjectRequest {
  /** PTY id or brainstorm session name to inject into. */
  target_session: string;
  /** HMAC token derived from auth secret + (signed subject) + unix_minute.
   * Subject defaults to target_session; can be overridden via
   * signed_session (when the route redirected a stale uuid onto a
   * live one) or signed_anchor_id (anchor-based signing). */
  token: string;
  /** Text to inject.  Max 4096 chars. */
  text: string;
  /** Optional caller label for audit log (e.g. 'cron', 'mobile-dashboard'). */
  caller_label?: string;
  /** If true, append \r to commit the line (default: true). */
  commit?: boolean;
  /** Fix 15 — HMAC verification runs against this string instead of
   * target_session. Set by the route layer when it redirected the
   * inject onto a different (live) session uuid than the one the
   * caller signed for. Defaults to target_session. */
  signed_session?: string;
  /** Fix 15 — alternate signing subject. When set, verification
   * accepts a token computed against this anchor id in addition to
   * the session-based form. Anchor ids are stable across /clear, so
   * supervisory callers should prefer this signing path. */
  signed_anchor_id?: string;
  /** Fix 15 — anchor id stamped onto the audit row when known. */
  anchor_id?: string;
}

export interface InjectResult {
  ok: boolean;
  decision:
    | 'accepted'
    | 'rejected_auth'
    | 'rejected_allowlist'
    | 'rejected_pty'
    | 'redirected'
    | 'dispatched_dead_session'
    | 'rejected_anchor_dormant';
  /** When 'accepted', which transport delivered the prompt. */
  transport?: 'pty' | 'bridge';
  error?: string;
  /** Fix 15 — when the route layer rewrote target_session because the
   * caller's uuid was stale, the inject path records the chosen
   * dispatch target so the audit row reflects what actually fired. */
  dispatched_to?: string;
  /** Fix 15 — anchor id resolved for this dispatch, when known. */
  anchor_id?: string;
}

/**
 * Test seams + tunables for crossSessionInject. The defaults wire up
 * the real PTY host, bridge writer, and setTimeout-based scheduler;
 * tests pass stubs so the inject path can be exercised without a
 * live PTY or a live VS Code bridge.
 */
export interface CrossSessionInjectDeps {
  listPtys?: typeof listPtys;
  ptyInject?: typeof ptyInject;
  queueSessionPrompt?: typeof queueSessionPrompt;
  queueSessionSuggestion?: typeof queueSessionSuggestion;
  /** Schedule the bare-CR nudge after the primary inject. Default
   * is setTimeout with .unref() so a daemon shutdown is not held
   * open by pending timers. */
  scheduleCommit?: (fn: () => void, delayMs: number) => void;
  /** Delay between primary inject and the bare-CR nudge. The
   * default sits in the middle of the bracketed-paste settle
   * window observed on the bridge VSIX path (~750-1000ms). */
  commitDelayMs?: number;
}

const DEFAULT_COMMIT_DELAY_MS = 850;

function defaultScheduleCommit(fn: () => void, delayMs: number): void {
  const t = setTimeout(fn, delayMs);
  if (typeof (t as { unref?: () => void }).unref === 'function') {
    (t as { unref: () => void }).unref();
  }
}

/**
 * Attempt a cross-session injection.  Always writes an audit row to db.
 * Never throws; errors are returned in InjectResult.
 *
 * After a successful primary inject, schedules a bare CR through the
 * SAME transport ~850 ms later so the worker's input box submits
 * even when the bridge VSIX strips the trailing CR off the bracketed
 * paste. The CR nudge is fire-and-forget; its outcome is not
 * surfaced in the returned InjectResult. The audit row covers the
 * primary inject only.
 */
export function crossSessionInject(
  req: InjectRequest,
  db: IndexDb,
  deps?: CrossSessionInjectDeps,
): InjectResult {
  const {
    target_session,
    token,
    text,
    caller_label,
    commit = true,
    signed_session,
    signed_anchor_id,
    anchor_id,
  } = req;
  const text_preview = text.slice(0, 120);
  const text_length = text.length;
  const listPtysFn = deps?.listPtys ?? listPtys;
  const ptyInjectFn = deps?.ptyInject ?? ptyInject;
  const queueSessionPromptFn = deps?.queueSessionPrompt ?? queueSessionPrompt;
  const queueSessionSuggestionFn =
    deps?.queueSessionSuggestion ?? queueSessionSuggestion;
  const scheduleCommit = deps?.scheduleCommit ?? defaultScheduleCommit;
  const commitDelayMs = deps?.commitDelayMs ?? DEFAULT_COMMIT_DELAY_MS;

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

  /* 1. Token auth. Fix 15 — accept tokens signed against the legacy
   * target_session, the route-overridden signed_session (when the
   * route redirected a stale uuid), or the anchor id (stable across
   * /clear-driven session uuid flips). */
  const subjects = [
    signed_session ?? target_session,
    signed_anchor_id ?? '',
  ];
  if (!verifyToken(subjects, token)) {
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

  /* 3. Prefer direct PTY inject when daemon owns the session's PTY
   * (faster, no bridge round-trip). Falls through to the bridge
   * marker-drop path for sessions launched outside daemon-owned
   * spawns (e.g. dashboard "Sessions" button → VS Code terminal). */
  const ptys = listPtysFn();
  const live = ptys.find(
    (p) => !p.exited && (p.ptyId === target_session || p.sessionId === target_session),
  );
  if (live) {
    const injectResult = ptyInjectFn(live.ptyId, text, commit);
    if (!injectResult.ok) {
      const reason = (injectResult as { ok: false; error: string }).error;
      audit('rejected_pty', reason);
      return { ok: false, decision: 'rejected_pty', error: reason };
    }
    audit('accepted');
    /* Auto-CR nudge. Some workers attached over the daemon-owned PTY
     * still leave the input box without a submit after the primary
     * inject; firing a bare CR through the same channel settles
     * that without needing an external poker. commit=false on the
     * nudge so the underlying ptyInject does not double-append a
     * second CR onto the already-CR-terminated text. */
    if (commit) {
      scheduleCommit(() => {
        try {
          ptyInjectFn(live.ptyId, '\r', false);
        } catch {
          /* nudge is fire-and-forget; primary inject already
           * succeeded so a CR failure does not fail the caller. */
        }
      }, commitDelayMs);
    }
    return { ok: true, decision: 'accepted', transport: 'pty' };
  }

  /* 4. Bridge fallback. queueSessionPrompt requires a session-id (not
   * a ptyId), so we only attempt this when target_session looks like
   * a UUID prefix or full UUID — the same shape sessions.ts resolves
   * via .claude jsonl scan. */
  const bridgeResult = commit
    ? queueSessionPromptFn(target_session, text)
    : queueSessionSuggestionFn(target_session, text);
  if (!bridgeResult.ok) {
    audit(
      'rejected_pty',
      `no live PTY and bridge fallback failed: ${bridgeResult.error}`,
    );
    return {
      ok: false,
      decision: 'rejected_pty',
      error: `no live PTY for "${target_session}" and bridge fallback failed: ${bridgeResult.error}`,
    };
  }

  audit('accepted');
  /* Auto-CR nudge through the bridge transport. The VS Code bridge
   * VSIX delivers the primary text via bracketed paste, which the
   * worker treats as a multi-character paste that does NOT include
   * the trailing CR -- so the text sits in the input box and Enter
   * never fires. A second bridge entry carrying just '\r' goes
   * through as a one-character paste and is interpreted as a
   * submit. ~850 ms gives the bridge time to drain the first entry
   * before the second one lands. */
  if (commit) {
    scheduleCommit(() => {
      try {
        queueSessionPromptFn(target_session, '\r');
      } catch {
        /* nudge is fire-and-forget */
      }
    }, commitDelayMs);
  }
  return { ok: true, decision: 'accepted', transport: 'bridge' };
}

/**
 * Generate a token for the current unix-minute.  Used by
 * POST /auth/cross-session-token so authenticated dashboard users can
 * get a short-lived token without reading auth.json directly.
 */
export function issueToken(targetSession: string): string {
  return deriveToken(targetSession, 0);
}
