"use client";

/**
 * Phase 5 of LEX-STANDALONE-SUPERVISION.
 *
 * "Standalone brainstorm idle activity" panel. One row per brainstorm
 * whose lifecycle_state is 'idle' or 'attached'. Shows the time since
 * the last user utterance, the last grooming pass kind/time, the
 * runtime mode, and the pass the watcher would fire if it ticked
 * right now.
 *
 * Pure read; data comes from GET /lex/idle-activity. Refreshes every
 * 30s so the silence durations stay current without hammering the
 * daemon.
 */
import { useQuery } from "@tanstack/react-query";
import {
  idleActivity,
  type IdleActivityGroomingKind,
  type IdleActivityRow,
} from "@/lib/daemon-client";

const QKEY = ["lex", "idle-activity"] as const;
const REFRESH_MS = 30_000;

const KIND_TONE: Record<IdleActivityGroomingKind, string> = {
  light: "bg-surface3 text-txt2",
  mid: "bg-warn/15 text-warn",
  cold: "bg-warn/30 text-warn",
  "day-cap": "bg-err/20 text-err",
};

function fmtDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 60 * 60_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 24 * 60 * 60_000) return `${(ms / (60 * 60_000)).toFixed(1)}h`;
  return `${Math.floor(ms / (24 * 60 * 60_000))}d`;
}

function fmtIso(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.valueOf())) return iso;
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function KindPill({
  kind,
}: {
  kind: IdleActivityGroomingKind | null;
}) {
  if (!kind) {
    return <span className="text-txt3 text-xs">none</span>;
  }
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-xs font-medium ${KIND_TONE[kind]}`}
    >
      {kind}
    </span>
  );
}

function IdleRow({ row }: { row: IdleActivityRow }) {
  return (
    <li className="flex flex-col gap-1 rounded border border-line bg-surface px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-medium text-txt1">
          {row.user_label ?? row.brainstormId.slice(0, 8)}
        </span>
        <span className="text-xs text-txt3">
          {row.lifecycle_state}
          {row.runtime_mode ? ` · ${row.runtime_mode}` : ""}
        </span>
      </div>
      <div className="grid grid-cols-3 gap-2 text-xs">
        <div>
          <div className="text-txt3">Silence</div>
          <div className="text-txt1">{fmtDuration(row.silence_ms)}</div>
        </div>
        <div>
          <div className="text-txt3">Last groom</div>
          <div className="text-txt1">
            <KindPill kind={row.last_grooming_kind} />
            <span className="ml-1 text-txt2">
              {fmtIso(row.last_grooming_pass_at)}
            </span>
          </div>
        </div>
        <div>
          <div className="text-txt3">Pending pass</div>
          <div className="text-txt1">
            <KindPill kind={row.pending_pass} />
          </div>
        </div>
      </div>
    </li>
  );
}

export function StandaloneIdleActivityPanel() {
  const query = useQuery({
    queryKey: QKEY,
    queryFn: () => idleActivity(),
    refetchInterval: REFRESH_MS,
  });

  const rows: IdleActivityRow[] = query.data?.rows ?? [];

  return (
    <section className="rounded-panel border border-line bg-surface2 p-4">
      <header className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-txt1">
            Standalone brainstorm idle activity
          </h2>
          <p className="text-sm text-txt3">
            Idle + attached brainstorms; the idle-watcher fires grooming
            passes once silence crosses 5m / 20m / 60m / 6h.
          </p>
        </div>
        {query.isFetching ? (
          <span className="text-xs text-txt3">refreshing…</span>
        ) : null}
      </header>
      {query.isError ? (
        <p className="text-sm text-err">
          Failed to load idle activity:{" "}
          {(query.error as Error | undefined)?.message ?? "unknown"}
        </p>
      ) : null}
      {!query.isError && rows.length === 0 ? (
        <p className="text-sm text-txt3">No idle or attached brainstorms.</p>
      ) : null}
      {rows.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {rows.map((row) => (
            <IdleRow key={row.brainstormId} row={row} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}
