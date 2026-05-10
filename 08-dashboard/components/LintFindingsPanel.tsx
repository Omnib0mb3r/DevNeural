"use client";

/**
 * Wave 2 day 4 step 15 (Karpathy steal 2 / A7). Surface for
 * audit_findings rows: lint, self-audit, canary, user-flag,
 * schema-regression. Severity colour-coded; one-click open page +
 * acknowledge / resolve / dismiss controls. Manual triggers for
 * lint-now and self-audit-now drop into the strip header.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  listAuditFindings,
  updateAuditFinding,
  triggerLintNow,
  triggerSelfAudit,
  type AuditFindingRow,
} from "@/lib/daemon-client";

const SEV_COLOR: Record<AuditFindingRow["severity"], string> = {
  high: "text-rose-400",
  medium: "text-amber-300",
  low: "text-txt3",
};

export function LintFindingsPanel() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["audit-findings", "open"],
    queryFn: () => listAuditFindings({ status: "open", limit: 100 }),
    refetchInterval: 10_000,
  });
  const ackM = useMutation({
    mutationFn: (id: string) => updateAuditFinding(id, "acknowledge"),
    onSettled: () => qc.invalidateQueries({ queryKey: ["audit-findings"] }),
  });
  const resolveM = useMutation({
    mutationFn: (id: string) => updateAuditFinding(id, "resolve"),
    onSettled: () => qc.invalidateQueries({ queryKey: ["audit-findings"] }),
  });
  const dismissM = useMutation({
    mutationFn: (id: string) => updateAuditFinding(id, "dismiss"),
    onSettled: () => qc.invalidateQueries({ queryKey: ["audit-findings"] }),
  });
  const lintM = useMutation({
    mutationFn: () => triggerLintNow(),
    onSettled: () => qc.invalidateQueries({ queryKey: ["audit-findings"] }),
  });
  const selfM = useMutation({
    mutationFn: () => triggerSelfAudit(10),
    onSettled: () => qc.invalidateQueries({ queryKey: ["audit-findings"] }),
  });
  const rows: AuditFindingRow[] = q.data?.findings ?? [];
  return (
    <section className="rounded-panel bg-surface1 hairline overflow-hidden">
      <div className="px-5 py-3 border-b border-border1 flex items-center gap-2">
        <h2 className="font-display text-sm font-emphasized">Audit findings</h2>
        <span className="text-nano text-txt3 ml-auto">{rows.length} open</span>
        <button
          type="button"
          onClick={() => lintM.mutate()}
          disabled={lintM.isPending}
          className="text-xs font-mono rounded border border-border1 bg-surface2 px-2 py-0.5 disabled:opacity-50"
        >
          {lintM.isPending ? "linting…" : "lint now"}
        </button>
        <button
          type="button"
          onClick={() => selfM.mutate()}
          disabled={selfM.isPending}
          className="text-xs font-mono rounded border border-border1 bg-surface2 px-2 py-0.5 disabled:opacity-50"
        >
          {selfM.isPending ? "auditing…" : "self-audit"}
        </button>
      </div>
      {q.isLoading ? (
        <p className="p-4 text-sm text-txt3">loading…</p>
      ) : rows.length === 0 ? (
        <p className="p-4 text-sm text-txt3">no open findings.</p>
      ) : (
        <ul className="divide-y divide-border2 max-h-96 overflow-y-auto">
          {rows.map((r) => (
            <li key={r.id} className="px-4 py-2 text-xs">
              <div className="flex items-center gap-2">
                <span
                  className={`font-mono uppercase tracking-wider ${SEV_COLOR[r.severity]}`}
                >
                  {r.severity}
                </span>
                <span className="font-mono text-txt3">{r.source}</span>
                {r.page_slug ? (
                  <a
                    href={`/wiki?id=${encodeURIComponent(r.page_slug)}`}
                    className="font-mono text-brandSoft hover:underline"
                  >
                    {r.page_slug}
                  </a>
                ) : null}
                <span className="ml-auto text-[10px] font-mono text-txt3">
                  {r.created_at.slice(0, 16).replace("T", " ")}
                </span>
              </div>
              <p className="text-txt2">{r.finding}</p>
              {r.detail ? (
                <p className="text-txt3 font-mono text-[11px]">{r.detail}</p>
              ) : null}
              <div className="mt-1 flex gap-2">
                <button
                  type="button"
                  onClick={() => ackM.mutate(r.id)}
                  className="rounded border border-border1 bg-surface2 px-2 py-0.5 font-mono"
                >
                  ack
                </button>
                <button
                  type="button"
                  onClick={() => resolveM.mutate(r.id)}
                  className="rounded border border-border1 bg-surface2 px-2 py-0.5 font-mono"
                >
                  resolve
                </button>
                <button
                  type="button"
                  onClick={() => dismissM.mutate(r.id)}
                  className="rounded border border-border1 bg-surface2 px-2 py-0.5 font-mono text-rose-400"
                >
                  dismiss
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
