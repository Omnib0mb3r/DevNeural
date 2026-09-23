/**
 * Handover approval registry (Phase C, 2026-09-22).
 *
 * After Lex reviews the worker's handover (POST /lex/smart-clear/review)
 * the approved frame waits here until the operator says yes by voice
 * (CONTROL: approve_handover) or the brain proceeds on its own when no
 * voice client is bound. The worker's SessionStart hook then consumes the
 * approved reseed through /worker/clear-handoff, so the fresh session
 * gets ONE seed (SMART-COMPACT.md section 5 item 3: kills the double
 * reseed). Pure and clocked by injection; the same shape as the dispatch
 * gate and the plan approval registry.
 */

export interface PendingHandover {
  /** The file name under brainstorms/<brainstormId>/. */
  handoverId: string;
  file: string;
  brainstormId: string;
  /** The worker's project anchor (project_session id). */
  projectAnchorId: string;
  /** The text pasted after /clear (reseedFromFrame). */
  reseed: string;
  /** What Layer 1 reads out. */
  gist: string;
  createdAtMs: number;
  approvedAtMs: number | null;
  rejectedAtMs: number | null;
  consumedAtMs: number | null;
}

export const HANDOVER_PENDING_TTL_MS = 15 * 60_000;
export const HANDOVER_APPROVED_TTL_MS = 15 * 60_000;

export class HandoverApprovalRegistry {
  private readonly items = new Map<string, PendingHandover>();

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly pendingTtlMs = HANDOVER_PENDING_TTL_MS,
    private readonly approvedTtlMs = HANDOVER_APPROVED_TTL_MS,
  ) {}

  register(
    p: Omit<PendingHandover, 'createdAtMs' | 'approvedAtMs' | 'rejectedAtMs' | 'consumedAtMs'>,
  ): PendingHandover {
    const entry: PendingHandover = {
      ...p,
      createdAtMs: this.now(),
      approvedAtMs: null,
      rejectedAtMs: null,
      consumedAtMs: null,
    };
    /* One live handover per brainstorm: a newer review replaces an
     * older unapproved one. */
    for (const [k, v] of this.items) {
      if (v.brainstormId === p.brainstormId && v.approvedAtMs === null) this.items.delete(k);
    }
    this.items.set(entry.handoverId, entry);
    return entry;
  }

  get(handoverId: string): PendingHandover | null {
    return this.items.get(handoverId) ?? null;
  }

  /** The unapproved, unrejected, unexpired handover for a brainstorm. */
  pendingForBrainstorm(brainstormId: string): PendingHandover | null {
    const t = this.now();
    for (const v of this.items.values()) {
      if (
        v.brainstormId === brainstormId &&
        v.approvedAtMs === null &&
        v.rejectedAtMs === null &&
        t - v.createdAtMs <= this.pendingTtlMs
      ) {
        return v;
      }
    }
    return null;
  }

  approve(brainstormId: string): PendingHandover | null {
    const p = this.pendingForBrainstorm(brainstormId);
    if (!p) return null;
    p.approvedAtMs = this.now();
    return p;
  }

  /** Lex drove the clear herself (clear-and-paste by handover id, no
   * voice client): mark the frame approved so the worker's clear-handoff
   * hook serves this frame instead of a recomputed legacy block. */
  approveById(handoverId: string): PendingHandover | null {
    const p = this.items.get(handoverId) ?? null;
    if (!p || p.rejectedAtMs !== null) return null;
    if (p.approvedAtMs === null) p.approvedAtMs = this.now();
    return p;
  }

  reject(brainstormId: string): PendingHandover | null {
    const p = this.pendingForBrainstorm(brainstormId);
    if (!p) return null;
    p.rejectedAtMs = this.now();
    return p;
  }

  /** The freshest approved, unconsumed handover for a worker anchor,
   * marked consumed so it is served exactly once. */
  consumeApproved(projectAnchorId: string): PendingHandover | null {
    const t = this.now();
    let best: PendingHandover | null = null;
    for (const v of this.items.values()) {
      if (
        v.projectAnchorId === projectAnchorId &&
        v.approvedAtMs !== null &&
        v.consumedAtMs === null &&
        t - v.approvedAtMs <= this.approvedTtlMs &&
        (best === null || v.approvedAtMs > (best.approvedAtMs ?? 0))
      ) {
        best = v;
      }
    }
    if (best) best.consumedAtMs = t;
    return best;
  }

  /** Drop expired entries; returns them. */
  expireNow(): PendingHandover[] {
    const t = this.now();
    const out: PendingHandover[] = [];
    for (const [k, v] of this.items) {
      const stale =
        (v.approvedAtMs === null && t - v.createdAtMs > this.pendingTtlMs) ||
        (v.approvedAtMs !== null && t - v.approvedAtMs > this.approvedTtlMs) ||
        v.rejectedAtMs !== null ||
        v.consumedAtMs !== null;
      if (stale) {
        this.items.delete(k);
        out.push(v);
      }
    }
    return out;
  }
}
