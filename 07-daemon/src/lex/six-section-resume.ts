/**
 * Six-section resume builder.
 *
 * v2 status: caller-side optional helper. The daemon no longer wires
 * this into smart-compact evaluate/fire — Lex authors the resume
 * prompt directly from its live conversation context and posts it as
 * opts.summary on /lex/smart-compact/fire. This module stays
 * available for any caller (Lex itself, a future external tool) that
 * wants a structured six-section scaffold instead of free-form prose,
 * but it is no longer the default resume path.
 *
 * Replaces the legacy single-paragraph `assembleSummary` in
 * `lex/smart-compact.ts`. Outputs a structured resume prompt with up
 * to six labelled sections:
 *
 *   1. Goal             what the worker is trying to build/fix
 *   2. Current State    where the work stands, blockers
 *   3. Files in flight  actively-modified files (git status + tool tail)
 *   4. Changed          commits since the last resume + WIP edits
 *   5. Failed attempts  what was tried and why it did not work
 *                       (LLM extraction; gated by confidence threshold
 *                        so hallucinated content is dropped)
 *   6. Next step        one concrete next thing to try
 *
 * Hard rule: an empty section is DROPPED, never padded. Section length
 * is adaptive; bias toward completeness when content exists.
 *
 * Source mapping (worker / smart-compact resume side):
 *   Goal / Current State  -> input.activeWork + input.lastActionSummary
 *   Files in flight       -> git status --short via input.diffStatShort
 *                            plus input.recentToolPaths (Read/Edit/Write)
 *   Changed               -> git log lines via input.recentCommits
 *   Failed attempts       -> async LLM extractor over recent assistant
 *                            turns, confidence-gated
 *   Next step             -> away_summary "Next:" line or
 *                            input.nextStep when supplied
 *
 * Pure module: every side effect flows through the input record. Tests
 * exercise each section's drop-vs-include path with fixture inputs.
 */

export interface SixSectionResumeInput {
  /** Human-readable project label (anchor.title or project_slug). */
  projectName: string;
  /** Pasted into the Goal section verbatim. May be empty. */
  activeWork: string;
  /** One-line current-state digest from the worker's recent activity
   * (e.g. "Reading 07-daemon/src/lex/foo.ts"). May be empty. */
  lastActionSummary: string;
  /** `git status --short` output lines for the worker's cwd. */
  diffStatShort: string[];
  /** Recent Read/Edit/Write tool target paths, newest last. Trimmed
   * to a reasonable cap by the caller. */
  recentToolPaths: string[];
  /** Recent git log oneline entries since the previous resume. */
  recentCommits: string[];
  /** Pre-extracted "Next:" line from the worker's own away_summary,
   * if it had one. Empty string when absent. */
  nextStepFromAwaySummary: string;
  /** Open audit findings count - rendered as a short Current State
   * call-out when non-zero. */
  openAuditFindings: number;
  /** Path to the active jsonl transcript so the resumed worker can
   * read the full history if needed. */
  jsonlPath: string;
  /** Recent assistant turns the failed-attempts extractor scans. The
   * extractor itself is injected via FailedAttemptsExtractor; when
   * the caller supplies neither this nor the extractor, the section
   * is dropped with reason='no-transcript'. */
  recentAssistantTurns?: string[];
}

export interface FailedAttemptsResult {
  items: string[];
  confidence: number;
  dropped_reason?: string;
}

export type FailedAttemptsExtractor = (
  turns: string[],
) => Promise<FailedAttemptsResult>;

export interface BuildSixSectionDeps {
  /** Pluggable extractor for the Failed attempts section. When
   * omitted the section is dropped with reason='no-extractor'. The
   * production wiring lives in six-section-resume-extractors.ts. */
  extractFailedAttempts?: FailedAttemptsExtractor;
  /** Minimum confidence (0-1) for the Failed attempts section to be
   * kept. Defaults to 0.6 - hallucinated content tends to come back
   * with confidence below this floor. */
  failedAttemptsConfidenceFloor?: number;
}

export interface SixSectionResumeResult {
  text: string;
  /** Section keys that were dropped + why, e.g. ["files_in_flight:empty"].
   * Surfaced for audit + telemetry. */
  dropped: string[];
}

/* Section keys, kept stable for audit and tests. */
export type SectionKey =
  | 'goal'
  | 'current_state'
  | 'files_in_flight'
  | 'changed'
  | 'failed_attempts'
  | 'next_step';

const SECTION_LABEL: Record<SectionKey, string> = {
  goal: 'Goal',
  current_state: 'Current state',
  files_in_flight: 'Files in flight',
  changed: 'Changed since last resume',
  failed_attempts: 'Failed attempts',
  next_step: 'Next step',
};

interface SectionDraft {
  key: SectionKey;
  /* Multi-line block; rendered under the section header. Empty means
   * the section is dropped. */
  body: string;
  drop_reason?: string;
}

function buildGoalSection(input: SixSectionResumeInput): SectionDraft {
  const goal = input.activeWork.trim();
  if (!goal) {
    return { key: 'goal', body: '', drop_reason: 'empty-active-work' };
  }
  return {
    key: 'goal',
    body: `You were working on ${input.projectName}. ${goal}`,
  };
}

function buildCurrentStateSection(input: SixSectionResumeInput): SectionDraft {
  const parts: string[] = [];
  const last = input.lastActionSummary.trim();
  if (last) parts.push(`Last action: ${last}`);
  if (input.openAuditFindings > 0) {
    parts.push(`Open audit findings for this project: ${input.openAuditFindings}.`);
  }
  if (parts.length === 0) {
    return {
      key: 'current_state',
      body: '',
      drop_reason: 'no-last-action-or-findings',
    };
  }
  return { key: 'current_state', body: parts.join('\n') };
}

function buildFilesInFlightSection(input: SixSectionResumeInput): SectionDraft {
  const status = input.diffStatShort
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  /* Dedupe + cap the tool-path tail to the most recent 8 distinct
   * paths. The extractor surface trusts the caller to have ordered
   * the array newest-last, so the dedupe walks back-to-front. */
  const tools: string[] = [];
  const seen = new Set<string>();
  for (let i = input.recentToolPaths.length - 1; i >= 0; i--) {
    const p = input.recentToolPaths[i]!;
    if (!p) continue;
    if (seen.has(p)) continue;
    seen.add(p);
    tools.unshift(p);
    if (tools.length >= 8) break;
  }
  if (status.length === 0 && tools.length === 0) {
    return {
      key: 'files_in_flight',
      body: '',
      drop_reason: 'no-status-no-tool-paths',
    };
  }
  const lines: string[] = [];
  if (status.length > 0) {
    lines.push('Working tree:');
    for (const s of status) lines.push(`  ${s}`);
  }
  if (tools.length > 0) {
    lines.push('Recent tool touches:');
    for (const t of tools) lines.push(`  ${t}`);
  }
  return { key: 'files_in_flight', body: lines.join('\n') };
}

function buildChangedSection(input: SixSectionResumeInput): SectionDraft {
  const commits = input.recentCommits
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
  if (commits.length === 0) {
    return { key: 'changed', body: '', drop_reason: 'no-recent-commits' };
  }
  const lines = ['Commits since last resume:'];
  for (const c of commits) lines.push(`  ${c}`);
  return { key: 'changed', body: lines.join('\n') };
}

function buildNextStepSection(input: SixSectionResumeInput): SectionDraft {
  const next = input.nextStepFromAwaySummary.trim();
  if (!next) {
    return { key: 'next_step', body: '', drop_reason: 'no-next-line' };
  }
  return { key: 'next_step', body: next };
}

export async function buildSixSectionResume(
  input: SixSectionResumeInput,
  deps: BuildSixSectionDeps = {},
): Promise<SixSectionResumeResult> {
  const drafts: SectionDraft[] = [
    buildGoalSection(input),
    buildCurrentStateSection(input),
    buildFilesInFlightSection(input),
    buildChangedSection(input),
  ];

  /* Failed attempts. The extractor is async + may call out to an LLM,
   * so the gate runs here rather than inside a sync builder. The
   * confidence floor drops obvious hallucination; the dropped reason
   * is logged for telemetry. */
  const turns = input.recentAssistantTurns ?? [];
  const floor = deps.failedAttemptsConfidenceFloor ?? 0.6;
  let failedAttemptsDraft: SectionDraft;
  if (!deps.extractFailedAttempts) {
    failedAttemptsDraft = {
      key: 'failed_attempts',
      body: '',
      drop_reason: 'no-extractor',
    };
  } else if (turns.length === 0) {
    failedAttemptsDraft = {
      key: 'failed_attempts',
      body: '',
      drop_reason: 'no-transcript',
    };
  } else {
    try {
      const r = await deps.extractFailedAttempts(turns);
      if (r.confidence < floor || r.items.length === 0) {
        failedAttemptsDraft = {
          key: 'failed_attempts',
          body: '',
          drop_reason:
            r.dropped_reason ??
            `low-confidence(${r.confidence.toFixed(2)}<${floor.toFixed(2)})`,
        };
      } else {
        const lines: string[] = [];
        for (const item of r.items) lines.push(`- ${item}`);
        failedAttemptsDraft = {
          key: 'failed_attempts',
          body: lines.join('\n'),
        };
      }
    } catch (err) {
      failedAttemptsDraft = {
        key: 'failed_attempts',
        body: '',
        drop_reason: `extractor-error:${(err as Error).message.slice(0, 60)}`,
      };
    }
  }
  drafts.push(failedAttemptsDraft);

  drafts.push(buildNextStepSection(input));

  /* Assemble. Sections are emitted in the canonical 1..6 order with
   * any dropped section silently skipped. The header line preserves
   * the worker's friendly orientation ("Context refreshed for
   * capacity"); the trailing transcript pointer mirrors what the
   * legacy assembleSummary used to ship. */
  const dropped: string[] = [];
  const kept: SectionDraft[] = [];
  for (const d of drafts) {
    if (!d.body) {
      dropped.push(`${d.key}:${d.drop_reason ?? 'empty'}`);
      continue;
    }
    kept.push(d);
  }
  const blocks: string[] = [];
  blocks.push(`You were working on ${input.projectName}. Context refreshed for capacity.`);
  for (const k of kept) {
    blocks.push('');
    blocks.push(`## ${SECTION_LABEL[k.key]}`);
    blocks.push(k.body);
  }
  blocks.push('');
  blocks.push(
    `Resume from where you left off. Full transcript: ${input.jsonlPath || '(unknown)'}.`,
  );
  return { text: blocks.join('\n'), dropped };
}
