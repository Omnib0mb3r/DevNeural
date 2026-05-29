/**
 * Loose-ends handoff gate (LEX-AUTONOMY codex item 10 / Fix 47).
 *
 * Pure detector + async enforcer module. Worker-start paths call
 * `enforceLooseEndsGate` BEFORE spawning or injecting; the gate
 * either clears the path, auto-resolves recoverable loose ends in a
 * bounded window, or blocks the start until the operator acts on the
 * surfaced report.
 *
 * Seven loose-end classes per investigation Section 2:
 *   mid_tool            (auto)
 *   parked_question     (operator)
 *   dirty_worktree      (operator)
 *   open_audit_finding  (operator)
 *   distill_error       (auto)
 *   undistilled_ref     (auto)
 *   stale_ref_beyond_T  (informational - Fix 43 already reminds)
 *
 * Defaults wired into the module-level constants. Pure over `db` +
 * injected I/O so tests drive every branch without spinning the
 * daemon up.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import type { IndexDb, LexTranscriptRefRow } from '../store/index-db.js';
import { isRefStale } from './lex-transcript-ref.js';

export type LooseEndClass =
  | 'mid_tool'
  | 'parked_question'
  | 'dirty_worktree'
  | 'open_audit_finding'
  | 'distill_error'
  | 'undistilled_ref'
  | 'stale_ref_beyond_T';

export type LooseEndDisposition = 'auto' | 'operator' | 'informational';
export type LooseEndSeverity = 'info' | 'warn' | 'alert';

export interface LooseEnd {
  class: LooseEndClass;
  disposition: LooseEndDisposition;
  severity: LooseEndSeverity;
  detail: string;
  evidence_ref_id?: number | null;
  evidence_cc_session_id?: string | null;
}

export interface LooseEndsReport {
  anchor_id: string;
  ends: LooseEnd[];
  has_blocker: boolean;
  has_auto: boolean;
  generated_ms: number;
}

export type GateDecisionKind = 'clear' | 'auto-resolving' | 'blocked';

export interface GateAutoAction {
  class: LooseEndClass;
  action: 'recovery-inject' | 'redistill';
  target: string;
  status: 'fired' | 'skipped' | 'failed';
  detail?: string;
}

export interface GateDecision {
  kind: GateDecisionKind;
  report: LooseEndsReport;
  auto_actions: GateAutoAction[];
}

export const LOOSE_ENDS_STALE_T_MS = 10 * 60_000;
export const LOOSE_ENDS_PARKED_QUESTION_AGE_MS = 120_000;
export const LOOSE_ENDS_AUTO_BUDGET_MS = 5_000;

const SEVERITY_RANK: Record<LooseEndSeverity, number> = {
  alert: 3,
  warn: 2,
  info: 1,
};
const DISPOSITION_RANK: Record<LooseEndDisposition, number> = {
  operator: 3,
  auto: 2,
  informational: 1,
};

function sortReport(ends: LooseEnd[]): LooseEnd[] {
  return ends.slice().sort((a, b) => {
    const sev = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (sev !== 0) return sev;
    const disp = DISPOSITION_RANK[b.disposition] - DISPOSITION_RANK[a.disposition];
    if (disp !== 0) return disp;
    return a.class.localeCompare(b.class);
  });
}

export interface EvaluateLooseEndsOptions {
  now?: () => number;
  readTranscript?: (path: string) => string | null;
  runGit?: (args: string[], cwd: string) => string | null;
}

/* Default jsonl reader for the gate's tail walkers. Exported so
 * sibling jsonl consumers (Fix 48 grooming-watch parked-question
 * detector) can reuse the same disk read instead of duplicating
 * the readFileSync + try/catch shape. */
export function readTranscriptFile(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf-8');
  } catch {
    return null;
  }
}

function defaultReadTranscript(p: string): string | null {
  return readTranscriptFile(p);
}

function defaultRunGit(args: string[], cwd: string): string | null {
  if (!cwd) return null;
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      timeout: 1500,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

/* Walk the jsonl tail for tool_use ids without matching tool_result.
 * Bounded to the last 100 records to keep the read cheap. */
function detectMidTool(
  jsonlText: string,
): { count: number; sample: string | null } {
  const lines = jsonlText.split(/\r?\n/).filter((l) => l.trim());
  const tail = lines.slice(-100);
  const pending = new Map<string, string>(); // tool_use_id -> first 60 char sample
  for (const line of tail) {
    let rec: {
      type?: string;
      message?: {
        content?: Array<{
          type?: string;
          id?: string;
          tool_use_id?: string;
          name?: string;
        }>;
      };
    };
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const parts = rec.message?.content;
    if (!Array.isArray(parts)) continue;
    for (const p of parts) {
      if (p?.type === 'tool_use' && typeof p.id === 'string') {
        pending.set(p.id, p.name ?? 'tool_use');
      } else if (
        p?.type === 'tool_result' &&
        typeof p.tool_use_id === 'string'
      ) {
        pending.delete(p.tool_use_id);
      }
    }
  }
  return {
    count: pending.size,
    sample: pending.size > 0 ? Array.from(pending.values())[0] ?? null : null,
  };
}

/* Walk the jsonl tail to determine whether the last assistant turn
 * ended with a question AND no user follow-up landed since. */
function detectParkedQuestion(
  jsonlText: string,
  now: number,
  ageThresholdMs: number,
): { parked: boolean; question: string | null; age_ms: number | null } {
  const lines = jsonlText.split(/\r?\n/).filter((l) => l.trim());
  let lastAssistantText = '';
  let lastAssistantMs: number | null = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    let rec: {
      type?: string;
      timestamp?: string;
      message?: {
        role?: string;
        content?:
          | string
          | Array<{ type?: string; text?: string }>;
      };
    };
    try {
      rec = JSON.parse(lines[i]!);
    } catch {
      continue;
    }
    if (rec.type === 'user') {
      /* A user turn after the candidate assistant turn means there's
       * no parked question. Walk from the end; finding user before
       * assistant means we already saw the user follow-up. */
      return { parked: false, question: null, age_ms: null };
    }
    if (rec.type === 'assistant') {
      const c = rec.message?.content;
      if (typeof c === 'string') lastAssistantText = c;
      else if (Array.isArray(c)) {
        for (const p of c) {
          if (p?.type === 'text' && typeof p.text === 'string') {
            lastAssistantText = p.text;
          }
        }
      }
      if (rec.timestamp) lastAssistantMs = Date.parse(rec.timestamp);
      break;
    }
  }
  const trimmed = lastAssistantText.trim();
  if (!trimmed.endsWith('?')) {
    return { parked: false, question: null, age_ms: null };
  }
  const ageMs = lastAssistantMs ? now - lastAssistantMs : ageThresholdMs + 1;
  if (ageMs < ageThresholdMs) {
    return { parked: false, question: null, age_ms: ageMs };
  }
  const last = trimmed.split(/(?<=[.!?])\s+/).pop() ?? trimmed;
  return {
    parked: true,
    question: last.length > 180 ? last.slice(0, 179) + '…' : last,
    age_ms: ageMs,
  };
}

export function evaluateLooseEnds(
  db: IndexDb,
  anchorId: string,
  opts: EvaluateLooseEndsOptions = {},
): LooseEndsReport {
  const now = (opts.now ?? Date.now)();
  const readTranscript = opts.readTranscript ?? defaultReadTranscript;
  const runGit = opts.runGit ?? defaultRunGit;
  const ends: LooseEnd[] = [];

  /* Pull refs once; reused by several detectors. */
  let refs: LexTranscriptRefRow[] = [];
  try {
    refs = db.listLexTranscriptRefs(anchorId);
  } catch {
    refs = [];
  }
  const latestRef = refs
    .slice()
    .sort((a, b) => b.ordering - a.ordering)[0];

  if (latestRef) {
    const jsonlText = readTranscript(latestRef.transcript_path);
    if (jsonlText) {
      const mid = detectMidTool(jsonlText);
      if (mid.count > 0) {
        ends.push({
          class: 'mid_tool',
          disposition: 'auto',
          severity: 'warn',
          detail: `${mid.count} tool_use without tool_result (e.g. ${mid.sample ?? 'unknown'})`,
          evidence_ref_id: latestRef.id,
          evidence_cc_session_id: latestRef.cc_session_id,
        });
      }
      const parked = detectParkedQuestion(
        jsonlText,
        now,
        LOOSE_ENDS_PARKED_QUESTION_AGE_MS,
      );
      if (parked.parked && parked.question) {
        ends.push({
          class: 'parked_question',
          disposition: 'operator',
          severity: 'alert',
          detail: `unanswered question: "${parked.question}"`,
          evidence_ref_id: latestRef.id,
          evidence_cc_session_id: latestRef.cc_session_id,
        });
      }
    }
  }

  /* Dirty worktree: anchor.cwd via project_session lookup. */
  try {
    const anchor = db.getBrainstorm(anchorId);
    const cwd = anchor?.cwd ?? '';
    if (cwd) {
      const status = runGit(['status', '--porcelain'], cwd);
      if (status && status.trim().length > 0) {
        const lines = status
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean);
        ends.push({
          class: 'dirty_worktree',
          disposition: 'operator',
          severity: 'warn',
          detail: `${lines.length} uncommitted change${lines.length === 1 ? '' : 's'}`,
        });
      }
    }
  } catch {
    /* observational */
  }

  /* Open audit findings (anchor-agnostic; surfaces high-severity
   * open rows). */
  try {
    const findings = db.listAuditFindings({
      status: 'open',
      severity: 'high',
      limit: 5,
    });
    if (findings.length > 0) {
      ends.push({
        class: 'open_audit_finding',
        disposition: 'operator',
        severity: 'warn',
        detail: `${findings.length} open high-severity audit finding${findings.length === 1 ? '' : 's'}`,
      });
    }
  } catch {
    /* observational */
  }

  /* Distill errors in last hour. */
  try {
    const errRows = db.listRecentDistillationErrors(50, {
      brainstormId: anchorId,
    });
    const cutoff = now - 60 * 60_000;
    const recent = errRows.filter((r) => {
      const t = Date.parse(r.ts);
      return Number.isFinite(t) && t >= cutoff;
    });
    if (recent.length > 0) {
      ends.push({
        class: 'distill_error',
        disposition: 'auto',
        severity: 'warn',
        detail: `${recent.length} distillation error${recent.length === 1 ? '' : 's'} in last hour`,
        evidence_cc_session_id: recent[0]?.cc_session_id ?? null,
      });
    }
  } catch {
    /* observational */
  }

  /* Undistilled refs: ended but no ref_summary. */
  const undistilled = refs.filter(
    (r) => r.ended_ms !== null && r.ref_summary === null,
  );
  if (undistilled.length > 0) {
    ends.push({
      class: 'undistilled_ref',
      disposition: 'auto',
      severity: 'info',
      detail: `${undistilled.length} ended ref${undistilled.length === 1 ? '' : 's'} missing distillation`,
      evidence_ref_id: undistilled[0]?.id ?? null,
      evidence_cc_session_id: undistilled[0]?.cc_session_id ?? null,
    });
  }

  /* Stale ref beyond T (informational; Fix 43 stale-watcher reminds). */
  const staleBeyondT = refs.filter((r) => {
    if (!isRefStale(r)) return false;
    if (r.latest_chunk_ms === null) return false;
    return now - r.latest_chunk_ms > LOOSE_ENDS_STALE_T_MS;
  });
  if (staleBeyondT.length > 0) {
    ends.push({
      class: 'stale_ref_beyond_T',
      disposition: 'informational',
      severity: 'info',
      detail: `${staleBeyondT.length} ref${staleBeyondT.length === 1 ? '' : 's'} stale beyond ${LOOSE_ENDS_STALE_T_MS / 60_000}min`,
    });
  }

  const sortedEnds = sortReport(ends);
  return {
    anchor_id: anchorId,
    ends: sortedEnds,
    has_blocker: sortedEnds.some((e) => e.disposition === 'operator'),
    has_auto: sortedEnds.some((e) => e.disposition === 'auto'),
    generated_ms: now,
  };
}

export interface EnforceGateOptions extends EvaluateLooseEndsOptions {
  /** Test seam: simulate auto-resolution outcomes without firing real
   * injects or distillation generators. Returns 'fired' / 'skipped' /
   * 'failed' per loose end. Production wiring (cross-session-inject +
   * createPerSessionDistillationGenerator) lands in the route adapter;
   * this module stays pure. */
  fireAutoAction?: (end: LooseEnd) => Promise<GateAutoAction>;
  /** Cap on the total auto-resolution window. */
  autoBudgetMs?: number;
}

export async function enforceLooseEndsGate(
  db: IndexDb,
  anchorId: string,
  opts: EnforceGateOptions = {},
): Promise<GateDecision> {
  const report = evaluateLooseEnds(db, anchorId, opts);
  if (report.has_blocker) {
    return { kind: 'blocked', report, auto_actions: [] };
  }
  if (!report.has_auto) {
    return { kind: 'clear', report, auto_actions: [] };
  }
  const budget = opts.autoBudgetMs ?? LOOSE_ENDS_AUTO_BUDGET_MS;
  const start = (opts.now ?? Date.now)();
  const auto_actions: GateAutoAction[] = [];
  const fire = opts.fireAutoAction ?? defaultFireAutoAction;
  for (const end of report.ends) {
    if (end.disposition !== 'auto') continue;
    const now = (opts.now ?? Date.now)();
    if (now - start >= budget) {
      auto_actions.push({
        class: end.class,
        action:
          end.class === 'distill_error' || end.class === 'undistilled_ref'
            ? 'redistill'
            : 'recovery-inject',
        target: end.evidence_cc_session_id ?? anchorId,
        status: 'skipped',
        detail: 'auto-budget exhausted',
      });
      continue;
    }
    try {
      const result = await fire(end);
      auto_actions.push(result);
    } catch (err) {
      auto_actions.push({
        class: end.class,
        action:
          end.class === 'distill_error' || end.class === 'undistilled_ref'
            ? 'redistill'
            : 'recovery-inject',
        target: end.evidence_cc_session_id ?? anchorId,
        status: 'failed',
        detail: (err as Error).message,
      });
    }
  }
  return { kind: 'auto-resolving', report, auto_actions };
}

/* Default no-op fire: returns 'skipped'. Production wires a real
 * cross-session-inject + distillation re-fire helper through the
 * route. Keeping the default inert means a bare evaluateLooseEnds +
 * enforceLooseEndsGate call works in tests without surprising
 * side-effects. */
async function defaultFireAutoAction(end: LooseEnd): Promise<GateAutoAction> {
  return {
    class: end.class,
    action:
      end.class === 'distill_error' || end.class === 'undistilled_ref'
        ? 'redistill'
        : 'recovery-inject',
    target: end.evidence_cc_session_id ?? '',
    status: 'skipped',
    detail: 'no fireAutoAction wired',
  };
}
