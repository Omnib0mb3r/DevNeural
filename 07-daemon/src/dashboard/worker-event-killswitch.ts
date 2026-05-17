/**
 * Worker event router kill-switch handler
 * (EVENT-DRIVEN-SUPERVISION.md "Constraints / decisions": hard
 * ceiling of >20 events / 10 min flips supervision_mode to 'polling'
 * for the offending anchor and surfaces the runaway to the user).
 *
 * The router's WorkerEventGate detects the runaway and exposes it
 * via routeWorkerEvent's onKillSwitch hook. This module is the
 * production binder: it persists the demotion AND emits a
 * warn-severity notification so the dashboard + web-push channel
 * make the trip impossible to miss.
 */
import type { IndexDb } from '../store/index-db.js';
import { emitNotification, type Notification } from './notifications.js';

export interface KillSwitchDeps {
  /** Notification emitter; defaults to the dashboard channel.
   * Tests inject a spy. */
  emit?: (input: {
    severity: 'info' | 'warn' | 'alert';
    source: string;
    title: string;
    body?: string;
    link?: string;
  }) => Notification | { id: string };
  /** Optional ledger so a second kill-switch on the same anchor
   * inside the cooldown window does not re-emit the notification.
   * Mutated in place. */
  alreadyTripped?: Set<string>;
}

export interface KillSwitchResult {
  anchor_id: string;
  prior_mode: string;
  next_mode: 'polling';
  notification_id: string | null;
  already_tripped: boolean;
}

/* Apply the kill-switch to a single anchor:
 *   1. Flip supervision_mode to 'polling' (no-op if already there).
 *   2. Emit a warn notification with a /projects link so the user
 *      can re-enable event mode after investigating.
 *
 * Returns the verdict so the caller (router binder) can log it. */
export function applyKillSwitch(
  db: IndexDb,
  anchorId: string,
  deps: KillSwitchDeps = {},
): KillSwitchResult {
  const tripped = deps.alreadyTripped;
  const dup = tripped?.has(anchorId) ?? false;
  if (tripped) tripped.add(anchorId);

  const row = db.getProjectSession(anchorId);
  const priorMode = row?.supervision_mode ?? 'polling';
  if (row && priorMode !== 'polling') {
    db.updateProjectSession(anchorId, { supervision_mode: 'polling' });
  }

  if (dup) {
    return {
      anchor_id: anchorId,
      prior_mode: priorMode,
      next_mode: 'polling',
      notification_id: null,
      already_tripped: true,
    };
  }

  const emit = deps.emit ?? emitNotification;
  const label = row?.title || row?.project_slug || anchorId.slice(0, 8);
  const n = emit({
    severity: 'warn',
    source: 'supervision',
    notify_class: 'signal',
    title: `Event-supervision kill-switch tripped for ${label}`,
    body: 'Too many worker events forwarded to Lex in a 10-minute window. supervision_mode flipped to polling. Re-enable from the Project tile after investigating.',
    link: '/projects',
  });
  return {
    anchor_id: anchorId,
    prior_mode: priorMode,
    next_mode: 'polling',
    notification_id: n.id,
    already_tripped: false,
  };
}

/* Convenience: bind applyKillSwitch into the shape RouteDeps.onKillSwitch
 * expects. Production caller in daemon.ts is just
 * `onKillSwitch: bindKillSwitch(db)`. */
export function bindKillSwitch(
  db: IndexDb,
  deps: KillSwitchDeps = {},
): (anchorId: string) => void {
  return (anchorId: string) => {
    applyKillSwitch(db, anchorId, deps);
  };
}
