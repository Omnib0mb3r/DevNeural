"use client";

/**
 * Wave 2 day 2 step 10 (BF-7 review / A2). Lists pending wiki_drafts
 * produced by the session-end auto-distillation pipeline; clicking
 * a row opens DraftEditor for inline edits + promote / discard.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AppShell } from "@/components/AppShell";
import { DraftEditor } from "@/components/DraftEditor";
import { listDrafts, type WikiDraftRow } from "@/lib/daemon-client";

export default function DraftsPage() {
  const [active, setActive] = useState<WikiDraftRow | null>(null);
  const q = useQuery({
    queryKey: ["drafts", "pending"],
    queryFn: () => listDrafts({ status: "pending", limit: 100 }),
    refetchInterval: 5_000,
  });
  const rows = q.data?.drafts ?? [];
  return (
    <AppShell>
      <div className="flex flex-col gap-3 p-4">
        <h1 className="text-xl font-semibold">Wiki drafts</h1>
        <p className="text-xs text-txt3">
          New wiki pages Lex wrote from your recent brainstorms. Review each one and accept, edit, or discard before it lands in the wiki.
        </p>
        {q.isLoading ? (
          <p className="text-sm text-txt3">loading…</p>
        ) : rows.length === 0 ? (
          <div className="rounded border border-dashed border-border1 bg-surface1 p-6 text-center text-sm text-txt3">
            <p>No drafts waiting on you.</p>
            <p className="mt-2 text-xs">
              Drafts appear here when a brainstorm session ends with enough
              substance (200+ characters of transcript); the local model
              distills it into a candidate wiki page for your review.
              Everything reviewed so far has already been promoted into the
              wiki, so an empty list means you&apos;re caught up, not that the
              pipeline is idle.
            </p>
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {rows.map((d) => (
              <li
                key={d.id}
                className="rounded border border-border1 bg-surface1 p-3"
              >
                <button
                  type="button"
                  onClick={() => setActive(d)}
                  className="block w-full text-left"
                >
                  <p className="font-mono text-sm">{d.page_title}</p>
                  <p className="text-[11px] font-mono text-txt3">
                    slug={d.page_slug} · confidence {(d.confidence * 100).toFixed(0)}% · {d.created_at}
                  </p>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {active ? (
        <DraftEditor draft={active} onClose={() => setActive(null)} />
      ) : null}
    </AppShell>
  );
}
