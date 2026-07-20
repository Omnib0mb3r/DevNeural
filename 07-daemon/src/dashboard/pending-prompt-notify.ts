/**
 * Pending-prompt bell policy (DRIVE-QUEUE rider, 2026-07-17): the bell
 * carries action-required items only.
 *
 * The pending-prompt route notified (warn + web push) on EVERY hook
 * notification, including kind=idle_prompt, which Claude Code fires at
 * every idle moment. During live voice conversation that meant a bell
 * row + push every turn boundary (four in four minutes, 03:12-03:16Z)
 * for a "waiting on you" that is just conversational rhythm. Policy:
 *
 *   - permission / elicitation / anything unknown: ALWAYS notify.
 *     Those block Claude until answered.
 *   - idle_prompt: notify on the first one, then debounce per session;
 *     an idle prompt that PERSISTS past the window notifies again
 *     (that one IS a stall worth a bell).
 *
 * Pure decision + a small per-session stamp map, split from routes.ts
 * so the policy is unit-testable.
 */

export const IDLE_PROMPT_DEBOUNCE_MS = 10 * 60 * 1000;

export function shouldNotifyPendingPrompt(
  kind: string,
  lastNotifiedMs: number | null,
  nowMs: number,
): boolean {
  if (kind !== 'idle_prompt') return true;
  if (lastNotifiedMs === null) return true;
  return nowMs - lastNotifiedMs > IDLE_PROMPT_DEBOUNCE_MS;
}

/** Bell class for a pending-prompt notification (2026-07-20 operator
 * directive: cut idle_prompt from the bell). A real permission /
 * elicitation prompt (or anything not idle) BLOCKS Claude until answered,
 * so it is a user action item -> 'followup' (bells). An idle_prompt is the
 * Claude Code housekeeping "still working?" rhythm, not an ask -> 'signal'
 * (activity rail / transcript only, never the bell). */
export function pendingPromptNotifyClass(kind: string): 'followup' | 'signal' {
  return kind === 'idle_prompt' ? 'signal' : 'followup';
}

/* Per-session last-notified stamps for idle_prompt. Bounded: sessions
 * churn, so cap the map and drop the oldest entry past the cap. */
const idleNotifiedAt = new Map<string, number>();
const CAP = 256;

export function markIdlePromptNotified(sessionId: string, nowMs: number): void {
  idleNotifiedAt.delete(sessionId);
  idleNotifiedAt.set(sessionId, nowMs);
  while (idleNotifiedAt.size > CAP) {
    const oldest = idleNotifiedAt.keys().next().value;
    if (oldest === undefined) break;
    idleNotifiedAt.delete(oldest);
  }
}

export function lastIdlePromptNotifiedMs(sessionId: string): number | null {
  return idleNotifiedAt.get(sessionId) ?? null;
}

/** Test seam. */
export function _resetIdlePromptStamps(): void {
  idleNotifiedAt.clear();
}
