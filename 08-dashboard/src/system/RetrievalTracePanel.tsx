"use client";

/**
 * Wave 3 Lane B step 35 (LX-12b). Retrieval trace panel.
 *
 * Polls GET /lex/retrieval-trace and renders a timeline of retrieval
 * decisions (chunks/wiki/grep/web) so the developer can see what Lex
 * searched and whether internal or external retrieval was used.
 *
 * Placed in src/system/ per the Lane B conflict-avoidance rule
 * (not in components/ which may conflict with Lane A).
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

interface RetrievalLogRow {
  id: string;
  brainstorm_id: string | null;
  ts: string;
  query: string;
  kind: "grep" | "chunks" | "wiki" | "web";
  results_json: string | null;
  decision: string | null;
}

type KindFilter = "all" | "grep" | "chunks" | "wiki" | "web";

const KIND_COLORS: Record<string, string> = {
  grep: "text-amber-400",
  chunks: "text-brand",
  wiki: "text-brandSoft",
  web: "text-red-400",
};

const KIND_LABELS: Record<string, string> = {
  grep: "grep",
  chunks: "chunks",
  wiki: "wiki",
  web: "web",
};

async function fetchRetrievalTrace(kind: KindFilter, limit: number): Promise<{ rows: RetrievalLogRow[]; total: number }> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (kind !== "all") params.set("kind", kind);
  const res = await fetch(`/lex/retrieval-trace?${params.toString()}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<{ rows: RetrievalLogRow[]; total: number }>;
}

function formatAge(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function RetrievalTracePanel({ brainstormId }: { brainstormId?: string }) {
  const [kind, setKind] = useState<KindFilter>("all");
  const [limit] = useState(50);

  const q = useQuery({
    queryKey: ["retrieval-trace", kind, limit, brainstormId],
    queryFn: () => fetchRetrievalTrace(kind, limit),
    refetchInterval: 10_000,
  });

  const rows: RetrievalLogRow[] = q.data?.rows ?? [];
  const filteredRows = brainstormId
    ? rows.filter((r) => r.brainstorm_id === brainstormId)
    : rows;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-txt1">Retrieval Trace</h2>
        <div className="flex gap-1">
          {(["all", "chunks", "wiki", "grep", "web"] as KindFilter[]).map((k) => (
            <button
              key={k}
              onClick={() => setKind(k)}
              className={`rounded px-2 py-0.5 text-xs font-mono border transition-colors ${
                kind === k
                  ? "border-brand bg-brand/10 text-brand"
                  : "border-border1 text-txt3 hover:border-brand/50"
              }`}
            >
              {k}
            </button>
          ))}
        </div>
      </div>

      {q.isLoading && (
        <div className="text-xs text-txt3 animate-pulse">Loading trace...</div>
      )}
      {q.isError && (
        <div className="text-xs text-red-400">
          Failed to load retrieval trace. Migration 015 may not have run yet.
        </div>
      )}

      {!q.isLoading && filteredRows.length === 0 && (
        <div className="text-xs text-txt3 italic">No retrieval events recorded yet.</div>
      )}

      <div className="flex flex-col gap-1 max-h-80 overflow-y-auto pr-1">
        {filteredRows.map((row) => (
          <div
            key={row.id}
            className="flex flex-col gap-0.5 rounded border border-border1 bg-surface2 px-3 py-2"
          >
            <div className="flex items-center justify-between gap-2">
              <span
                className={`text-xs font-mono font-semibold uppercase tracking-wide ${KIND_COLORS[row.kind] ?? "text-txt2"}`}
              >
                {KIND_LABELS[row.kind] ?? row.kind}
              </span>
              <span className="text-xs text-txt3 shrink-0">{formatAge(row.ts)}</span>
            </div>
            <div className="text-xs text-txt1 truncate" title={row.query}>
              {row.query}
            </div>
            {row.decision && (
              <div className="text-xs text-txt3 truncate" title={row.decision}>
                {row.decision}
              </div>
            )}
            {row.brainstorm_id && !brainstormId && (
              <div className="text-xs text-txt3 font-mono">
                brainstorm: {row.brainstorm_id.slice(0, 8)}
              </div>
            )}
          </div>
        ))}
      </div>

      {filteredRows.length > 0 && (
        <div className="text-xs text-txt3 text-right">
          {filteredRows.length} event{filteredRows.length !== 1 ? "s" : ""}
        </div>
      )}
    </div>
  );
}
