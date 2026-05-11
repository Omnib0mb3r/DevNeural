"use client";

/**
 * Wave 3 Lane B step 37 (LX-14). Janitor approval UI.
 *
 * Lists open audit_findings with source='janitor' (merge candidates
 * and contradiction flags). The user can dismiss false positives or
 * acknowledge genuine issues to route them into the resolution queue.
 *
 * Placed in src/system/ per the Lane B conflict-avoidance rule.
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

interface JanitorFinding {
  id: string;
  source: string;
  severity: "low" | "medium" | "high";
  brainstorm_id: string | null;
  finding: string;
  detail: string | null;
  status: "open" | "acknowledged" | "resolved" | "dismissed";
  created_at: string;
}

async function fetchJanitorFindings(): Promise<{ findings: JanitorFinding[] }> {
  const res = await fetch(
    "/audit-findings?source=janitor&status=open&limit=50"
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<{ findings: JanitorFinding[] }>;
}

async function updateFindingStatus(
  id: string,
  action: "acknowledge" | "dismiss"
): Promise<void> {
  const res = await fetch(`/audit-findings/${id}/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

async function runJanitor(): Promise<{ ok: boolean; result: unknown }> {
  const res = await fetch("/admin/janitor/run", { method: "POST" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<{ ok: boolean; result: unknown }>;
}

function severityBadge(s: string): string {
  if (s === "high") return "bg-red-500/20 text-red-400 border-red-500/40";
  if (s === "medium") return "bg-amber-500/20 text-amber-400 border-amber-500/40";
  return "bg-surface3 text-txt3 border-border1";
}

function formatAge(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  const h = Math.floor(diff / 3_600_000);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function JanitorApprovalsPanel() {
  const qc = useQueryClient();
  const [runResult, setRunResult] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ["janitor-findings"],
    queryFn: fetchJanitorFindings,
    refetchInterval: 30_000,
  });

  const dismiss = useMutation({
    mutationFn: (id: string) => updateFindingStatus(id, "dismiss"),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["janitor-findings"] }); },
  });

  const acknowledge = useMutation({
    mutationFn: (id: string) => updateFindingStatus(id, "acknowledge"),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["janitor-findings"] }); },
  });

  const triggerRun = useMutation({
    mutationFn: runJanitor,
    onSuccess: (data) => {
      setRunResult(JSON.stringify(data.result, null, 2));
      void qc.invalidateQueries({ queryKey: ["janitor-findings"] });
    },
    onError: (err) => {
      setRunResult(`Error: ${(err as Error).message}`);
    },
  });

  const findings: JanitorFinding[] = q.data?.findings ?? [];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-txt1">Memory Janitor</h2>
        <button
          onClick={() => triggerRun.mutate()}
          disabled={triggerRun.isPending}
          className="rounded border border-border1 bg-surface2 px-3 py-1 text-xs font-mono hover:border-brand/50 disabled:opacity-50"
        >
          {triggerRun.isPending ? "Running..." : "Run now"}
        </button>
      </div>

      {runResult && (
        <pre className="rounded border border-border1 bg-surface3 p-2 text-xs text-txt2 overflow-x-auto max-h-32">
          {runResult}
        </pre>
      )}

      {q.isLoading && (
        <div className="text-xs text-txt3 animate-pulse">Loading findings...</div>
      )}
      {q.isError && (
        <div className="text-xs text-red-400">
          Failed to load janitor findings.
        </div>
      )}

      {!q.isLoading && findings.length === 0 && (
        <div className="text-xs text-txt3 italic">
          No open janitor findings. Run the janitor to scan for merge candidates and contradictions.
        </div>
      )}

      <div className="flex flex-col gap-2 max-h-96 overflow-y-auto pr-1">
        {findings.map((f) => {
          let detail: unknown = null;
          try {
            if (f.detail) detail = JSON.parse(f.detail) as unknown;
          } catch {
            detail = null;
          }
          const d = detail as {
            chunk_a?: { preview?: string };
            chunk_b?: { preview?: string };
            cosine?: number;
          } | null;

          return (
            <div
              key={f.id}
              className="flex flex-col gap-1 rounded border border-border1 bg-surface2 px-3 py-2"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span
                    className={`rounded border px-1.5 py-0.5 text-xs font-mono ${severityBadge(f.severity)}`}
                  >
                    {f.severity}
                  </span>
                  <span className="text-xs text-txt2 font-mono">
                    {f.source}
                  </span>
                </div>
                <span className="text-xs text-txt3 shrink-0">{formatAge(f.created_at)}</span>
              </div>
              <div className="text-xs text-txt1">{f.finding}</div>
              {d && (
                <div className="text-xs text-txt3 italic space-y-0.5">
                  {d.chunk_a?.preview && (
                    <div className="truncate">A: {d.chunk_a.preview}</div>
                  )}
                  {d.chunk_b?.preview && (
                    <div className="truncate">B: {d.chunk_b.preview}</div>
                  )}
                  {d.cosine != null && (
                    <div>cosine: {d.cosine.toFixed(3)}</div>
                  )}
                </div>
              )}
              <div className="flex gap-1 pt-1">
                <button
                  onClick={() => acknowledge.mutate(f.id)}
                  disabled={acknowledge.isPending}
                  className="rounded border border-border1 bg-surface3 px-2 py-0.5 text-xs hover:border-brand/50 disabled:opacity-50"
                >
                  Acknowledge
                </button>
                <button
                  onClick={() => dismiss.mutate(f.id)}
                  disabled={dismiss.isPending}
                  className="rounded border border-border1 bg-surface3 px-2 py-0.5 text-xs hover:border-red-500/50 disabled:opacity-50"
                >
                  Dismiss
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {findings.length > 0 && (
        <div className="text-xs text-txt3 text-right">
          {findings.length} open finding{findings.length !== 1 ? "s" : ""}
        </div>
      )}
    </div>
  );
}
