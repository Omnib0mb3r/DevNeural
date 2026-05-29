/**
 * LEX-AUTONOMY codex 10a (Fix 47 partial closure step 1).
 *
 * Production fireAutoAction implementation for the loose-ends gate.
 * The gate module (`loose-ends-gate.ts`) stays pure; this adapter
 * binds the anchor + db + transport seams once per gate invocation
 * and returns the closure the gate calls per auto-disposition end.
 *
 * Dispatch table (by LooseEnd.class):
 *   - mid_tool          -> cross-session-inject with RECOVERY_INJECT_BODY +
 *                          bare-CR follow-up (inherits from the existing
 *                          cancelled-tool-recovery transport contract;
 *                          one consistent recovery body across both
 *                          surfaces).
 *   - distill_error     -> per-session distillation generator over the
 *                          ref's cc_session_id chunks. On non-null
 *                          result, write ref_summary back via
 *                          updateLexTranscriptRef and stamp an audit
 *                          row with caller_label='loose-ends-auto-resolve'.
 *   - undistilled_ref   -> identical to distill_error path; the gate
 *                          surfaces them as separate ends so the
 *                          dashboard report can distinguish the
 *                          underlying causes, but the resolution is
 *                          the same per-session regenerate.
 *
 * Operator-disposition classes (parked_question, dirty_worktree,
 * open_audit_finding) never reach this function because
 * enforceLooseEndsGate filters disposition !== 'auto'. The default
 * branch is defensive only: an unknown auto class returns
 * status='skipped' rather than throwing.
 */
import { randomUUID } from 'node:crypto';
import {
  crossSessionInject as defaultCrossSessionInject,
  issueToken as defaultIssueToken,
} from './cross-session-inject.js';
import { RECOVERY_INJECT_BODY } from './cancelled-tool-recovery.js';
import type { IndexDb } from '../store/index-db.js';
import type { GateAutoAction, LooseEnd } from './loose-ends-gate.js';
import type { PerSessionDistillationGenerator } from './distillation-generator.js';

export interface LooseEndsAutoActionDeps {
  db: IndexDb;
  /** Anchor (brainstorm / lex_session id) the gate is enforcing on.
   * Used as the audit row's brainstorm_id stamp and as the fallback
   * target when a loose end lacks an evidence_cc_session_id. */
  anchorId: string;
  /** Optional logger; bootstrap failures and per-class outcomes flow
   * through here so the smart-compact route can correlate gate
   * activity with the rest of the inject pipeline. */
  log?: (msg: string) => void;
  /** Test seam: real distillation generator OR a stub that returns
   * a fixed string. The real path is wired by the route adapter
   * using createPerSessionDistillationGenerator + pickProvider so
   * BF-4 (no anthropic for brainstorm content) is preserved. */
  perSessionGenerator?: PerSessionDistillationGenerator;
  /** Test seam: cross-session inject transport. */
  crossSessionInject?: typeof defaultCrossSessionInject;
  /** Test seam: HMAC token issuer. */
  issueToken?: typeof defaultIssueToken;
  /** Test seam: clock for the ref_summary_ms stamp. */
  now?: () => number;
}

export type LooseEndsFireAutoAction = (
  end: LooseEnd,
) => Promise<GateAutoAction>;

const CALLER_LABEL = 'loose-ends-auto-resolve';

export function createLooseEndsFireAutoAction(
  deps: LooseEndsAutoActionDeps,
): LooseEndsFireAutoAction {
  const log = deps.log ?? ((): void => undefined);
  const inject = deps.crossSessionInject ?? defaultCrossSessionInject;
  const issue = deps.issueToken ?? defaultIssueToken;
  const now = deps.now ?? Date.now;

  async function fireRecoveryInject(end: LooseEnd): Promise<GateAutoAction> {
    const target = end.evidence_cc_session_id ?? deps.anchorId;
    try {
      const result = inject(
        {
          target_session: target,
          token: issue(target),
          text: RECOVERY_INJECT_BODY,
          caller_label: CALLER_LABEL,
          commit: true,
          anchor_id: deps.anchorId,
        },
        deps.db,
      );
      if (result.ok) {
        log(
          `[loose-ends-auto] mid_tool fired cc=${target.slice(0, 8)} transport=${result.transport ?? '?'}`,
        );
        return {
          class: end.class,
          action: 'recovery-inject',
          target,
          status: 'fired',
        };
      }
      log(
        `[loose-ends-auto] mid_tool failed cc=${target.slice(0, 8)} decision=${result.decision}`,
      );
      return {
        class: end.class,
        action: 'recovery-inject',
        target,
        status: 'failed',
        detail: result.error ?? result.decision,
      };
    } catch (err) {
      return {
        class: end.class,
        action: 'recovery-inject',
        target,
        status: 'failed',
        detail: (err as Error).message,
      };
    }
  }

  async function fireRedistill(end: LooseEnd): Promise<GateAutoAction> {
    const ccId = end.evidence_cc_session_id ?? null;
    if (!ccId) {
      return {
        class: end.class,
        action: 'redistill',
        target: deps.anchorId,
        status: 'skipped',
        detail: 'no cc_session_id on loose end',
      };
    }
    if (!deps.perSessionGenerator) {
      log(
        `[loose-ends-auto] ${end.class} skipped cc=${ccId.slice(0, 8)} no per-session generator wired`,
      );
      return {
        class: end.class,
        action: 'redistill',
        target: ccId,
        status: 'skipped',
        detail: 'no per-session generator (provider not configured or anthropic blocked)',
      };
    }
    let totalChunks = 0;
    try {
      totalChunks = deps.db.countBrainstormChunksForSession(
        deps.anchorId,
        ccId,
      );
    } catch {
      /* db read failure leaves totalChunks=0; generator may still
       * succeed and we simply lose coverage_score precision. */
    }
    let output: Awaited<ReturnType<PerSessionDistillationGenerator>> = null;
    try {
      output = await deps.perSessionGenerator({
        brainstorm_id: deps.anchorId,
        cc_session_id: ccId,
        totalChunksInSession: totalChunks,
      });
    } catch (err) {
      return {
        class: end.class,
        action: 'redistill',
        target: ccId,
        status: 'failed',
        detail: (err as Error).message,
      };
    }
    if (!output || !output.summary || output.summary.trim().length === 0) {
      log(
        `[loose-ends-auto] ${end.class} generator returned null cc=${ccId.slice(0, 8)}`,
      );
      return {
        class: end.class,
        action: 'redistill',
        target: ccId,
        status: 'failed',
        detail: 'generator returned null',
      };
    }
    const trimmed = output.summary.trim();
    /* Persist the regenerated summary onto the matching ref row +
     * carry the provenance fields the per-session generator
     * supplies (source_chunk_count, source_session_ids,
     * coverage_score) so the dashboard's freshness pill renders
     * the right number after auto-resolve. */
    let refUpdated = false;
    try {
      const refs = deps.db.listLexTranscriptRefs(deps.anchorId);
      const ref = refs.find((r) => r.cc_session_id === ccId);
      if (ref) {
        deps.db.updateLexTranscriptRef(ref.id, {
          ref_summary: trimmed,
          ref_summary_ms: now(),
          source_chunk_count: output.source_chunk_count,
          source_session_ids: output.source_session_ids,
          coverage_score: output.coverage_score,
        });
        refUpdated = true;
      }
    } catch {
      /* observational; audit row still records the regenerate */
    }
    try {
      deps.db.insertCrossSessionLog({
        id: randomUUID(),
        target_session: ccId,
        caller_label: CALLER_LABEL,
        text_preview: trimmed.slice(0, 120),
        text_length: trimmed.length,
        decision: 'accepted',
        reject_reason: JSON.stringify({
          class: end.class,
          action: 'redistill',
          ref_updated: refUpdated,
          coverage_score: output.coverage_score,
        }),
        brainstorm_id: deps.anchorId,
      });
    } catch {
      /* audit failures must not block the gate decision */
    }
    log(
      `[loose-ends-auto] ${end.class} fired cc=${ccId.slice(0, 8)} ref_updated=${refUpdated}`,
    );
    return {
      class: end.class,
      action: 'redistill',
      target: ccId,
      status: 'fired',
      detail: refUpdated ? undefined : 'ref not found; audit only',
    };
  }

  return async (end: LooseEnd): Promise<GateAutoAction> => {
    if (end.class === 'mid_tool') return fireRecoveryInject(end);
    if (end.class === 'distill_error' || end.class === 'undistilled_ref') {
      return fireRedistill(end);
    }
    /* Defensive default: the gate already filters disposition !== 'auto',
     * but if a future auto-disposition class lands without a dispatch
     * entry here we report skipped rather than fired so the audit
     * tracks the gap. */
    return {
      class: end.class,
      action: 'recovery-inject',
      target: end.evidence_cc_session_id ?? deps.anchorId,
      status: 'skipped',
      detail: 'no dispatch entry for class',
    };
  };
}
