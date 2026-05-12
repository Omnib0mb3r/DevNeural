"use client";

/**
 * Smart-compact audit panel.
 *
 * Renders the last 20 smart_compact_log rows tone-coded by outcome:
 *   shadow -> muted (default ship state, no live inject)
 *   fire   -> ok    (live /clear + summary inject succeeded)
 *   wrap   -> warn  (forced-no-stop, wrap-and-commit injected)
 *   noop   -> alert (evaluator returned wait but row was forced)
 *
 * Each row is expandable; the body shows full payload_text (full
 * resume prompt or WRAP_AND_COMMIT_PROMPT) with a fallback to
 * summary_preview for legacy rows that pre-date migration 023.
 *
 * Read-only; the actual firing happens server-side from the
 * scheduler tick. Mounted on /system below the panic audit panel.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  recentSmartCompacts,
  type SmartCompactLogRow,
} from "@/lib/daemon-client";

type Action = SmartCompactLogRow["action"];

const TONE: Record<Action, string> = {
  shadow: "text-txt3",
  fire: "text-ok",
  wrap: "text-warn",
  noop: "text-err",
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

function fmtCtx(p: number | null): string {
  if (p === null || p === undefined) return "—";
  return `${Math.round(p)}%`;
}

export function SmartCompactAuditPanel() {
  const q = useQuery({
    queryKey: ["smart-compact", "recent"],
    queryFn: () => recentSmartCompacts(20),
    refetchInterval: 10_000,
  });
  const [expanded, setExpanded] = useState<string | null>(null);
  const rows = q.data?.rows ?? [];

  return (
    <section
      data-testid="smart-compact-audit-panel"
      className="rounded-panel bg-surface1 hairline"
    >
      <header className="px-4 py-3 border-b border-border1 flex items-center justify-between">
        <h2 className="text-sm font-emphasized text-txt1">
          Smart compact audit
        </h2>
        <span className="text-nano text-txt3 uppercase tracking-wider">
          last 20
        </span>
      </header>
      {q.isLoading ? (
        <div className="px-4 py-6 text-xs text-txt3">loading</div>
      ) : rows.length === 0 ? (
        <div className="px-4 py-6 text-xs text-txt3">
          No smart-compact attempts recorded yet.
        </div>
      ) : (
        <ul className="divide-y divide-border2 max-h-96 overflow-y-auto">
          {rows.map((r) => {
            const isOpen = expanded === r.id;
            const body = r.payload_text ?? r.summary_preview ?? "";
            return (
              <li
                key={r.id}
                data-testid="smart-compact-row"
                data-action={r.action}
                className="text-xs"
              >
                <button
                  type="button"
                  aria-expanded={isOpen}
                  onClick={() => setExpanded(isOpen ? null : r.id)}
                  className="w-full px-4 py-2.5 flex items-start gap-3 text-left hover:bg-surface2/40"
                >
                  <span className="font-mono text-txt3 w-32 shrink-0">
                    {fmtTs(r.ts)}
                  </span>
                  <span
                    className={`font-emphasized w-20 shrink-0 ${TONE[r.action]}`}
                    data-testid="smart-compact-action"
                  >
                    {r.action}
                  </span>
                  <span className="font-mono text-txt2 w-40 shrink-0 truncate">
                    {r.reason}
                  </span>
                  <span className="font-mono text-txt2 w-24 shrink-0">
                    pre {fmtCtx(r.pre_ctx_pct)}
                  </span>
                  <span className="font-mono text-txt2 truncate flex-1 min-w-0">
                    anchor=
                    {r.anchor_id ? r.anchor_id.slice(0, 8) : "none"}
                  </span>
                  <span className="ml-auto text-txt3 font-mono shrink-0">
                    {r.caller}
                  </span>
                </button>
                {isOpen && (
                  <div
                    data-testid="smart-compact-row-body"
                    className="px-4 pb-3 pt-1 text-[11px] font-mono text-txt2 whitespace-pre-wrap"
                  >
                    {body || "(no payload captured)"}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
