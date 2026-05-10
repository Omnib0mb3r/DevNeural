"use client";

/**
 * Wave 2 day 3 step 13 (BF-13). Borderline-band review: each row
 * lists a brainstorm + candidate page slug + cosine, and the user
 * one-clicks Link or Reject. Trigger button kicks off a fresh
 * backfill-brainstorms run via the daemon admin endpoint.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AppShell } from "@/components/AppShell";
import {
  listBackfillReview,
  linkBackfillReview,
  rejectBackfillReview,
  triggerBackfillBrainstorms,
  type BackfillReviewRow,
} from "@/lib/daemon-client";

export default function BackfillReviewPage() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["backfill-review", "pending"],
    queryFn: () => listBackfillReview({ status: "pending", limit: 200 }),
    refetchInterval: 8_000,
  });
  const linkM = useMutation({
    mutationFn: (id: string) => linkBackfillReview(id),
    onSettled: () => qc.invalidateQueries({ queryKey: ["backfill-review"] }),
  });
  const rejectM = useMutation({
    mutationFn: (id: string) => rejectBackfillReview(id),
    onSettled: () => qc.invalidateQueries({ queryKey: ["backfill-review"] }),
  });
  const runM = useMutation({
    mutationFn: () => triggerBackfillBrainstorms(),
    onSettled: () => qc.invalidateQueries({ queryKey: ["backfill-review"] }),
  });
  const rows: BackfillReviewRow[] = q.data?.candidates ?? [];
  return (
    <AppShell>
      <div className="flex flex-col gap-3 p-4">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold">Backfill review</h1>
          <button
            type="button"
            onClick={() => runM.mutate()}
            disabled={runM.isPending}
            className="rounded border border-border1 bg-surface2 px-3 py-1 text-sm font-mono disabled:opacity-50"
          >
            {runM.isPending ? "running…" : "run backfill"}
          </button>
        </div>
        <p className="text-xs text-txt3">
          borderline-band candidates from npm run backfill-brainstorms.
          link writes source_brainstorms onto the wiki page; reject
          marks the row resolved without linking.
        </p>
        {runM.data?.result ? (
          <pre className="rounded border border-border1 bg-surface1 p-2 text-[11px] font-mono text-txt2">
{JSON.stringify(runM.data.result, null, 2)}
          </pre>
        ) : null}
        {q.isLoading ? (
          <p className="text-sm text-txt3">loading…</p>
        ) : rows.length === 0 ? (
          <div className="rounded border border-dashed border-border1 bg-surface1 p-6 text-center text-sm text-txt3">
            no pending candidates.
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {rows.map((r) => (
              <li
                key={r.id}
                className="flex items-center gap-3 rounded border border-border1 bg-surface1 p-3 text-xs"
              >
                <div className="flex-1">
                  <p className="font-mono">{r.candidate_page_slug}</p>
                  <p className="text-[11px] font-mono text-txt3">
                    brainstorm={r.brainstorm_id} · cosine {r.cosine.toFixed(3)} · {r.band}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => linkM.mutate(r.id)}
                  disabled={linkM.isPending}
                  className="rounded border border-brandSoft bg-brandSoft px-2 py-1 font-mono text-bg1 disabled:opacity-50"
                >
                  link
                </button>
                <button
                  type="button"
                  onClick={() => rejectM.mutate(r.id)}
                  disabled={rejectM.isPending}
                  className="rounded border border-border1 bg-surface2 px-2 py-1 font-mono text-rose-400 disabled:opacity-50"
                >
                  reject
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </AppShell>
  );
}
