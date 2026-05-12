"use client";

/**
 * Panic audit panel (PANIC-BUTTON.md step 7).
 *
 * Renders the last 20 panic_log rows so the user can audit what got
 * interrupted, by whom, and whether the inject reached a live PTY.
 * Refreshes every 10 seconds; not load-bearing so a daemon hiccup just
 * leaves the previous snapshot on screen.
 */
import { useQuery } from "@tanstack/react-query";
import { recentPanics, type PanicLogRow } from "@/lib/daemon-client";

const RESULT_TONE: Record<PanicLogRow["result"], string> = {
  accepted: "text-ok",
  pty_not_found: "text-warn",
  no_target: "text-txt3",
};

function fmtTs(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.valueOf())) return ts;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function PanicAuditPanel() {
  const q = useQuery({
    queryKey: ["panic", "recent"],
    queryFn: () => recentPanics(20),
    refetchInterval: 10_000,
  });

  const rows = q.data?.panics ?? [];

  return (
    <section className="rounded-panel bg-surface1 hairline">
      <header className="px-4 py-3 border-b border-border1 flex items-center justify-between">
        <h2 className="text-sm font-emphasized text-txt1">Panic audit</h2>
        <span className="text-nano text-txt3 uppercase tracking-wider">
          last 20
        </span>
      </header>
      {q.isLoading ? (
        <div className="px-4 py-6 text-xs text-txt3">loading</div>
      ) : rows.length === 0 ? (
        <div className="px-4 py-6 text-xs text-txt3">
          No panic fires recorded yet.
        </div>
      ) : (
        <ul className="divide-y divide-border2 max-h-96 overflow-y-auto">
          {rows.map((r) => (
            <li
              key={r.id}
              className="px-4 py-2.5 flex items-start gap-3 text-xs"
            >
              <span className="font-mono text-txt3 w-32 shrink-0">
                {fmtTs(r.ts)}
              </span>
              <span className={`font-emphasized w-28 shrink-0 ${RESULT_TONE[r.result]}`}>
                {r.result}
              </span>
              <span className="font-mono text-txt2 truncate">
                anchor=
                {r.target_anchor_id ? r.target_anchor_id.slice(0, 8) : "none"}
                {r.target_pty_id ? `, pty=${r.target_pty_id.slice(0, 8)}` : ""}
                {r.target_session_id
                  ? `, cc=${r.target_session_id.slice(0, 8)}`
                  : ""}
              </span>
              <span className="ml-auto text-txt3 font-mono shrink-0">
                {r.caller}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
