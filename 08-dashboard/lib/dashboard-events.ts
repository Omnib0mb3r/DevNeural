"use client";

/**
 * Dashboard SSE subscriber.
 *
 * Singleton EventSource bound to /dashboard/events. Components
 * register listeners via subscribeDashboardEvents and unsubscribe via
 * the returned disposer. The first subscriber opens the stream; the
 * last unsubscribe closes it. Browser auto-reconnects an interrupted
 * EventSource so callers do not need to retry.
 */

export type DashboardEvent =
  | { type: "brainstorm-ended"; brainstorm_id: string; ended_ms: number };

type Listener = (ev: DashboardEvent) => void;

let source: EventSource | null = null;
const listeners = new Set<Listener>();

function ensureSource(): void {
  if (source) return;
  if (typeof window === "undefined") return;
  try {
    source = new EventSource("/dashboard/events");
  } catch {
    source = null;
    return;
  }
  source.onmessage = (msg) => {
    if (!msg.data) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(msg.data as string);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object") return;
    const ev = parsed as DashboardEvent;
    if (typeof ev.type !== "string") return;
    for (const fn of listeners) {
      try {
        fn(ev);
      } catch {
        /* listener errors must not break the bus */
      }
    }
  };
  source.onerror = () => {
    /* EventSource auto-reconnects; nothing to do. */
  };
}

function teardownIfIdle(): void {
  if (listeners.size > 0) return;
  if (!source) return;
  try {
    source.close();
  } catch {
    /* ignore */
  }
  source = null;
}

export function subscribeDashboardEvents(fn: Listener): () => void {
  listeners.add(fn);
  ensureSource();
  return () => {
    listeners.delete(fn);
    teardownIfIdle();
  };
}
