"use client";

/**
 * Wave 2 day 4 step 17 (CI-4 + CI-5 / A9). Renders one curator
 * injection with the confidence pill (CI-4) and the "this looks
 * wrong" button (CI-5). Posting "wrong" goes through /curator/wrong:
 * weight drop, archive-on-3, plus a user-flag finding so the
 * self-audit picks the page up next pass.
 *
 * Usable both inside ReinforcementPanel rows (when the row carries
 * a page id) and in any future curator-decision surface.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { curatorWrong } from "@/lib/daemon-client";

export interface InjectionRowProps {
  page_id: string;
  curator_log_id?: string;
  /** 0..1 confidence from the curator decision; null when unknown. */
  confidence?: number | null;
  preview?: string;
  ts?: string;
}

function confidenceColor(c: number): string {
  if (c >= 0.8) return "text-promoted";
  if (c >= 0.5) return "text-brandSoft";
  if (c >= 0.3) return "text-amber-300";
  return "text-rose-400";
}

export function InjectionRow({ page_id, curator_log_id, confidence, preview, ts }: InjectionRowProps) {
  const qc = useQueryClient();
  const wrongM = useMutation({
    mutationFn: () => curatorWrong(page_id, curator_log_id ? { curator_log_id } : {}),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["reinforcement"] });
      qc.invalidateQueries({ queryKey: ["audit-findings"] });
    },
  });
  const c = typeof confidence === "number" ? confidence : null;
  return (
    <div className="flex items-center gap-2 text-xs">
      <a
        href={`/wiki?id=${encodeURIComponent(page_id)}`}
        className="font-mono text-brandSoft hover:underline"
      >
        {page_id}
      </a>
      {c !== null ? (
        <span
          className={`rounded bg-surface2 px-1.5 py-0.5 font-mono ${confidenceColor(c)}`}
          title={`curator confidence ${(c * 100).toFixed(0)}%`}
        >
          {(c * 100).toFixed(0)}%
        </span>
      ) : null}
      {preview ? (
        <span className="text-txt3 truncate max-w-md">{preview}</span>
      ) : null}
      {ts ? <span className="ml-auto font-mono text-[10px] text-txt3">{ts}</span> : null}
      <button
        type="button"
        onClick={() => wrongM.mutate()}
        disabled={wrongM.isPending || wrongM.isSuccess}
        className="rounded border border-border1 bg-surface2 px-2 py-0.5 font-mono text-rose-400 disabled:opacity-50"
        title="this looks wrong: drop page weight + flag for self-audit"
      >
        {wrongM.isSuccess ? "flagged" : wrongM.isPending ? "…" : "wrong"}
      </button>
    </div>
  );
}
