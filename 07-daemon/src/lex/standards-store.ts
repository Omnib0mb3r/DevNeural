/* Memory-that-compounds: standards store + proposer (DRIVE-QUEUE 5a,
 * EXPLORATORY first slice).
 *
 * A layer ABOVE the existing memory/distillation FACT store: a periodic
 * investigator pass reads decision/memory records and PROPOSES candidate
 * standards from recurring patterns:
 *   - the same trade-off chosen >= N times  -> propose a meta-rule.
 *   - a newer decision contradicting an older one on the same topic
 *     -> flag a contradiction.
 *
 * CRITICAL: proposals are candidates only. They are NEVER auto-applied as
 * live rules; Lex or the human confirms before they harden. This module
 * emits candidates + holds them; it never writes a live rule. Pure over
 * its inputs so the proposer is unit-testable.
 */

export interface MemoryRecord {
  /** Stable id of the source memory / decision. */
  id: string;
  /** What the decision is about (the grouping key). */
  topic: string;
  /** The choice made (e.g. "sqlite", "commit-first"). */
  choice: string;
  /** ms-since-epoch the decision landed (orders contradiction detection). */
  ts: number;
}

export type StandardKind = 'meta-rule' | 'contradiction';
export type StandardStatus = 'candidate' | 'confirmed';

export interface StandardCandidate {
  kind: StandardKind;
  topic: string;
  /** The recurring choice (meta-rule) or the new contradicting choice. */
  choice: string;
  /** For a contradiction: the prior choice it conflicts with. */
  priorChoice?: string;
  /** Source memory ids backing the proposal (the evidence). */
  evidenceIds: string[];
  rationale: string;
  status: StandardStatus;
  proposedMs: number;
}

export interface ProposeOptions {
  /** Repeats of the same (topic, choice) before a meta-rule is proposed.
   * Default 3 ("chose X over Y three times"). */
  repeatThreshold?: number;
  /** Clock for proposedMs (injected for deterministic tests). */
  now?: () => number;
}

function norm(s: string): string {
  return s.trim().toLowerCase();
}

/* Propose candidate standards from a set of memory/decision records.
 * Returns candidates only; nothing is applied. */
export function proposeStandards(
  records: MemoryRecord[],
  opts: ProposeOptions = {},
): StandardCandidate[] {
  const threshold = Math.max(2, opts.repeatThreshold ?? 3);
  const nowMs = (opts.now ?? Date.now)();
  const out: StandardCandidate[] = [];

  /* Group by topic, ordered oldest-first so contradiction detection sees
   * the established choice before a later flip. */
  const byTopic = new Map<string, MemoryRecord[]>();
  for (const r of records) {
    const key = norm(r.topic);
    const arr = byTopic.get(key) ?? [];
    arr.push(r);
    byTopic.set(key, arr);
  }

  for (const [, group] of byTopic) {
    const sorted = [...group].sort((a, b) => a.ts - b.ts);
    const topic = sorted[0]!.topic;

    /* Meta-rule: the same choice repeated >= threshold times. */
    const choiceCounts = new Map<string, MemoryRecord[]>();
    for (const r of sorted) {
      const k = norm(r.choice);
      const arr = choiceCounts.get(k) ?? [];
      arr.push(r);
      choiceCounts.set(k, arr);
    }
    for (const [, recs] of choiceCounts) {
      if (recs.length >= threshold) {
        out.push({
          kind: 'meta-rule',
          topic,
          choice: recs[0]!.choice,
          evidenceIds: recs.map((r) => r.id),
          rationale: `Chose "${recs[0]!.choice}" for "${topic}" ${recs.length} times; propose as a standing meta-rule.`,
          status: 'candidate',
          proposedMs: nowMs,
        });
      }
    }

    /* Contradiction: a newer record's choice differs from the first
     * established choice on the same topic. */
    const established = sorted[0]!;
    const conflicting = sorted.find(
      (r) => norm(r.choice) !== norm(established.choice),
    );
    if (conflicting) {
      out.push({
        kind: 'contradiction',
        topic,
        choice: conflicting.choice,
        priorChoice: established.choice,
        evidenceIds: [established.id, conflicting.id],
        rationale: `New decision "${conflicting.choice}" for "${topic}" contradicts the earlier "${established.choice}"; confirm which stands.`,
        status: 'candidate',
        proposedMs: nowMs,
      });
    }
  }

  return out;
}

/* Confirm a candidate (Lex / human gate). Returns a new confirmed copy;
 * does NOT write a live rule here - hardening into the live rule set is a
 * separate, deliberate step outside this first slice. */
export function confirmStandard(c: StandardCandidate): StandardCandidate {
  return { ...c, status: 'confirmed' };
}

/* In-memory candidate store. The investigator pass appends proposals;
 * dedupe is by (kind, topic, choice) so re-running the proposer does not
 * pile up duplicates. Persistence + the live-rule harden step are future
 * work; this first slice keeps candidates in memory + returns them. */
export class StandardsStore {
  private candidates: StandardCandidate[] = [];

  propose(records: MemoryRecord[], opts?: ProposeOptions): StandardCandidate[] {
    const fresh = proposeStandards(records, opts);
    const added: StandardCandidate[] = [];
    for (const c of fresh) {
      const dup = this.candidates.some(
        (e) =>
          e.kind === c.kind &&
          norm(e.topic) === norm(c.topic) &&
          norm(e.choice) === norm(c.choice),
      );
      if (!dup) {
        this.candidates.push(c);
        added.push(c);
      }
    }
    return added;
  }

  list(kind?: StandardKind): StandardCandidate[] {
    return kind
      ? this.candidates.filter((c) => c.kind === kind)
      : [...this.candidates];
  }

  size(): number {
    return this.candidates.length;
  }
}
