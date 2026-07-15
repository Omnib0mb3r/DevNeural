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
import {
  resolveDeliverableBridgeForSession,
  type DeliverabilityResult,
} from '../dashboard/bridge-presence.js';
import {
  recordExpectationWithPolicy,
  deriveExpectedOutcome,
} from './expectation-supervisor.js';
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
  /** Worker scope (2026-07-08). The Lex anchor the CALLER speaks
   * for. When present, the inject may only target the worker that
   * anchor supervises (current/previous session id or PTY of the
   * supervised project_session) or the anchor's own brainstorm
   * session/PTY. Anything else is rejected with
   * decision='rejected_scope'. Absent = legacy behavior for
   * daemon-internal supervisors, cron, and the dashboard. */
  from_lex_anchor_id?: string;
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
    | 'rejected_anchor_dormant'
    /* Worker scope (2026-07-08). The caller declared which Lex
     * anchor it speaks for (from_lex_anchor_id) and the target is
     * not that anchor's supervised worker or its own brainstorm. */
    | 'rejected_scope'
    /* Bug 3e (2026-05-22). Daemon refuses to queue a bridge marker
     * when no fresh presence file claims the target uuid AT ALL
     * (verdict='not_claimed') or claims it without owning a terminal
     * (verdict='no_terminal'). Returned so callers (Lex) react to a
     * real failure instead of treating a queue-file-write as
     * delivery. */
    | 'no_deliverable_bridge';
  /** When 'accepted', which transport delivered the prompt. */
  transport?: 'pty' | 'bridge';
  error?: string;
  /** Fix 15 — when the route layer rewrote target_session because the
   * caller's uuid was stale, the inject path records the chosen
   * dispatch target so the audit row reflects what actually fired. */
  dispatched_to?: string;
  /** Fix 15 — anchor id resolved for this dispatch, when known. */
  anchor_id?: string;
  /** Bug 3e — for delivery-failed verdicts, the reason classifier
   * from resolveDeliverableBridgeForSession. Helps Lex distinguish
   * "no bridge even claims this uuid" (worker never opened a window)
   * from "bridge claims but has no terminal" (window closed). */
  deliverability_verdict?: 'not_claimed' | 'no_terminal';
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
  /** Bug 3e (2026-05-22): bridge deliverability gate. Default reads
   * the live `.bridge-presence` directory via
   * resolveDeliverableBridgeForSession. Tests stub this so the
   * inject path can be exercised without a real presence dir. */
  resolveDeliverableBridge?: (ccSessionId: string) => DeliverabilityResult;
}

const DEFAULT_COMMIT_DELAY_MS = 850;

function defaultScheduleCommit(fn: () => void, delayMs: number): void {
  const t = setTimeout(fn, delayMs);
  if (typeof (t as { unref?: () => void }).unref === 'function') {
    (t as { unref: () => void }).unref();
  }
}

export interface LexScopeCheck {
  allowed: boolean;
  /** Human-readable reason when rejected; audit + caller feedback. */
  reason: string | null;
  /** Slug of the supervised worker, for caller feedback. */
  supervised_slug: string | null;
}

/**
 * Worker-scope membership check (2026-07-08). Answers: may the Lex
 * anchor `fromLexAnchorId` target `target`? Allowed targets:
 *   - the supervised project_session's current_session_id,
 *     previous_session_id, or current_pty_id,
 *   - the anchor's own brainstorm claude_session_id or pty_id.
 * Prefix matching mirrors the bridge path's uuid-prefix resolution:
 * a target qualifies when it equals an allowed id or is a prefix of
 * one (>= 8 chars, the same shape sessions.ts resolves).
 * Exported for the /lex/steer route so both control surfaces enforce
 * the identical scope.
 */
/** Supervised project anchor id for a Lex anchor, with the SAME
 * fallback chain as snapshot-context's resolveLexScope: canonical
 * lex_session.supervises_project_anchor_id first, then the legacy
 * brainstorm project_scope_id mirror. Keeping the enforcement
 * surfaces on the identical resolution prevents a legacy-scoped
 * anchor from seeing worker X in its snapshot while being rejected
 * (or worse, allowed elsewhere) on inject. */
export function supervisedAnchorIdFor(
  db: IndexDb,
  lexAnchorId: string,
): string | null {
  const lex = db.getLexSession(lexAnchorId);
  if (lex?.supervises_project_anchor_id) {
    return lex.supervises_project_anchor_id;
  }
  try {
    const bs = db.getBrainstorm(lexAnchorId) as
      | ({ project_scope_id?: string | null } & Record<string, unknown>)
      | null;
    return bs?.project_scope_id ?? null;
  } catch {
    return null;
  }
}

export function checkLexScope(
  db: IndexDb,
  fromLexAnchorId: string,
  target: string,
): LexScopeCheck {
  const lex = db.getLexSession(fromLexAnchorId);
  if (!lex) {
    return {
      allowed: false,
      reason: `unknown lex anchor "${fromLexAnchorId}"`,
      supervised_slug: null,
    };
  }
  const allowed = new Set<string>();
  let slug: string | null = null;
  try {
    const own = db.getBrainstorm(fromLexAnchorId);
    if (own?.claude_session_id) allowed.add(own.claude_session_id);
    if (own?.pty_id) allowed.add(own.pty_id);
  } catch {
    /* legacy mirror row is optional */
  }
  if (lex.current_pty_id) allowed.add(lex.current_pty_id);
  const supervisedId = supervisedAnchorIdFor(db, fromLexAnchorId);
  if (supervisedId) {
    const proj = db.getProjectSession(supervisedId);
    if (proj) {
      slug = proj.project_slug;
      if (proj.current_session_id) allowed.add(proj.current_session_id);
      if (proj.previous_session_id) allowed.add(proj.previous_session_id);
      if (proj.current_pty_id) allowed.add(proj.current_pty_id);
    }
  }
  const t = target.trim();
  const match =
    t.length >= 8 &&
    [...allowed].some((id) => id === t || id.startsWith(t));
  if (match) return { allowed: true, reason: null, supervised_slug: slug };
  const scopeDesc = slug
    ? `this brainstorm supervises only "${slug}"`
    : 'this brainstorm supervises no worker';
  return {
    allowed: false,
    reason: `target "${target}" is outside the scope of lex anchor "${fromLexAnchorId}" (${scopeDesc})`,
    supervised_slug: slug,
  };
}

/**
 * Standalone audit-row writer for rejected_scope decisions made
 * OUTSIDE crossSessionInject itself (control-transport fix,
 * 2026-07-14). /lex/steer, /sessions/:id/prompt, /sessions/:id/suggest,
 * and /sessions/:id/inject each run their own checkLexScope gate
 * before reaching (or instead of ever reaching) crossSessionInject,
 * so a rejection there previously vanished with no audit trail —
 * exactly the gap this closes. Writes the identical row shape the
 * internal audit() closure below produces for decision='rejected_scope'
 * so GET /lex/injection-log reads consistently regardless of which
 * route produced the row. Never throws; a db write failure must not
 * block the caller's 403 response.
 */
export function auditRejectedScope(
  db: IndexDb,
  opts: {
    target_session: string;
    caller_label?: string | null;
    text: string;
    reason: string;
  },
): void {
  try {
    db.insertCrossSessionLog({
      id: randomUUID(),
      target_session: opts.target_session,
      caller_label: opts.caller_label ?? null,
      text_preview: opts.text.slice(0, 120),
      text_length: opts.text.length,
      decision: 'rejected_scope',
      reject_reason: opts.reason,
      brainstorm_id: null,
    });
  } catch {
    /* db write failure must not affect the caller */
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
    from_lex_anchor_id,
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
  const resolveDeliverableBridge =
    deps?.resolveDeliverableBridge ??
    ((ccSessionId: string) => resolveDeliverableBridgeForSession(ccSessionId));

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

  /* Expectation-supervisor dispatcher wiring (2026-07-15 goal-audit
   * fix wave). recordExpectation's only writer was, until this wave,
   * nothing at all: the 90s evaluator ticked forever over an
   * eternally-empty lex_worker_expectation table. This is the
   * natural authority boundary for the cross-session transport -- a
   * COMMITTED delivery to a known worker project-session anchor
   * (anchor_id), sent by a Lex anchor that declared itself
   * (from_lex_anchor_id), is exactly the "Lex told the worker to do
   * X" event the expectation row models. Both fields are already
   * resolved by the caller (routes.ts's resolveDispatchTarget /
   * checkLexScope) before crossSessionInject ever runs, so this is a
   * read of state already on hand, not a new resolution.
   *
   * Deliberately excluded:
   *   - commit:false (suggestions) -- nothing was actually delivered
   *     for the worker to act on yet.
   *   - anchor_id absent -- covers self-injects into Lex's own
   *     brainstorm session (checkLexScope allows those) and targets
   *     with no known project anchor; neither has a worker jsonl to
   *     tail.
   *   - from_lex_anchor_id absent -- daemon-internal supervisors,
   *     cron, and the dashboard's own operator-typed injects are not
   *     "Lex dispatched a task" events.
   *
   * Best-effort by design: recordExpectationWithPolicy reaches through
   * the brainstorm-store's getStore() singleton, not the `db` handle
   * this function was called with, so a store not yet initialised
   * (or any other write failure) must not turn an already-successful
   * inject into a caller-visible error.
   *
   * Supersede policy (2026-07-15): crossSessionInject is synchronous
   * end to end (see the function signature above), and stays that way
   * here -- widening it to return a Promise is out of scope for this
   * closure. recordExpectationWithPolicy is async (it may classify
   * against open rows via an LLM call before writing), so this fires
   * it without awaiting, exactly like the CR nudge a few lines below
   * fires setTimeout without awaiting. The .catch keeps a rejected
   * policy promise from becoming an unhandled rejection; it does not
   * (and must not) affect the InjectResult already returned to the
   * caller. */
  function recordDispatchExpectation(): void {
    if (!commit || !from_lex_anchor_id || !anchor_id) return;
    void recordExpectationWithPolicy(
      {},
      {
        brainstormId: from_lex_anchor_id,
        anchorId: anchor_id,
        expectedOutcome: deriveExpectedOutcome(text),
      },
    ).catch(() => {
      /* best-effort; see comment above */
    });
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

  /* 2b. Worker scope (2026-07-08). A caller that declares which Lex
   * anchor it speaks for may only reach that anchor's supervised
   * worker or its own brainstorm. This is the daemon-side backstop
   * for the prompt-side scope contract: even a drifting Lex cannot
   * control another brainstorm's worker. */
  if (from_lex_anchor_id) {
    const scope = checkLexScope(db, from_lex_anchor_id, target_session);
    if (!scope.allowed) {
      audit('rejected_scope', scope.reason ?? 'out of scope');
      return {
        ok: false,
        decision: 'rejected_scope',
        error:
          scope.reason ??
          `target "${target_session}" is outside this brainstorm's worker scope`,
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
    recordDispatchExpectation();
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
   * via .claude jsonl scan.
   *
   * Bug 3e (2026-05-22): before writing the marker, confirm at least
   * one fresh bridge presence record reports has_terminal_for_uuid
   * for the target. Without this gate the marker lands in a sinkhole
   * (no bridge owns a terminal) and the audit row reports 'accepted'
   * for what is in fact a silent drop. Migration grace (verdict =
   * 'legacy-grace') keeps older bridges working through the rollout
   * window. */
  const deliverability = resolveDeliverableBridge(target_session);
  if (
    deliverability.verdict === 'not_claimed' ||
    deliverability.verdict === 'no_terminal'
  ) {
    const reason =
      deliverability.verdict === 'not_claimed'
        ? `no fresh bridge presence claims "${target_session}"`
        : `bridge presence claims "${target_session}" but no terminal owns it`;
    audit('no_deliverable_bridge', reason);
    return {
      ok: false,
      decision: 'no_deliverable_bridge',
      error: reason,
      deliverability_verdict: deliverability.verdict,
    };
  }
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
  recordDispatchExpectation();
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
