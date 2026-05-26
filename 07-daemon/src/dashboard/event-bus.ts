/**
 * Dashboard event bus.
 *
 * In-process EventEmitter. SSE clients subscribed on /dashboard/events
 * receive every published event. One channel, one discriminated-union
 * payload type so the wire format stays small and the dashboard can
 * exhaustively switch on `type`.
 *
 * Publishers fire-and-forget; emit failures must not throw back into
 * the caller (writers wrap publishDashboardEvent in try/catch already).
 */
import { EventEmitter } from 'node:events';

export type DashboardEvent =
  | { type: 'brainstorm-ended'; brainstorm_id: string; ended_ms: number };

export const dashboardEvents = new EventEmitter();
/* SSE connection count is bounded by browser tab count; 200 covers
 * the normal multi-tab user plus headroom without warning spam. */
dashboardEvents.setMaxListeners(200);

export function publishDashboardEvent(ev: DashboardEvent): void {
  dashboardEvents.emit('event', ev);
}
