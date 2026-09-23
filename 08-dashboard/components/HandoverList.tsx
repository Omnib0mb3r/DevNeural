"use client";

/**
 * Handover list (2026-09-22 plan, Task 10, Phase C).
 *
 * The brainstorm detail page lists the timestamped handover files the
 * daemon wrote for the anchor: newest first, each row with its date,
 * kind and verdict, an "unvetted" badge when Lex has not reviewed the
 * file yet, and an expand action that fetches the file body and shows
 * it preformatted so both halves (the worker's and Lex's) read as
 * written. Scope: only this anchor's files; the daemon route is keyed
 * on the anchor id.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  lexHandoverFile,
  lexHandovers,
  type HandoverRow,
} from "@/lib/daemon-client";

/** Newest first by created_at; ties (or unparseable stamps) fall back
 * to the file name, which the writer prefixes with the same stamp. */
export function sortHandoversNewestFirst(rows: HandoverRow[]): HandoverRow[] {
  return [...rows].sort((a, b) => {
    const ta = Date.parse(a.created_at);
    const tb = Date.parse(b.created_at);
    if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return tb - ta;
    return b.file.localeCompare(a.file);
  });
}

function stamp(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Date(t).toISOString().slice(0, 16).replace("T", " ");
}

export function HandoverList({ anchorId }: { anchorId: string }) {
  const q = useQuery({
    queryKey: ["lex-handovers", anchorId],
    queryFn: () => lexHandovers(anchorId),
    refetchInterval: 15_000,
  });
  const [openFile, setOpenFile] = useState<string | null>(null);
  const rows = sortHandoversNewestFirst(q.data?.ok ? q.data.handovers : []);
  return (
    <section data-testid="brainstorm-detail-handovers">
      <h2 className="text-sm font-semibold">Handovers</h2>
      <p className="text-nano text-txt3 mb-1">
        Timestamped handover files written for this anchor, newest first.
        The worker writes the first half and Lex vets it; a file marked
        unvetted has not been reviewed yet.
      </p>
      {q.isLoading ? (
        <p className="text-xs text-txt3">loading…</p>
      ) : q.isError || (q.data && !q.data.ok) ? (
        <p className="text-xs text-txt3">handover list unavailable.</p>
      ) : rows.length === 0 ? (
        <p className="text-xs text-txt3">No handovers yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((row) => (
            <HandoverItem
              key={row.file}
              anchorId={anchorId}
              row={row}
              open={openFile === row.file}
              onToggle={() =>
                setOpenFile((cur) => (cur === row.file ? null : row.file))
              }
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function HandoverItem({
  anchorId,
  row,
  open,
  onToggle,
}: {
  anchorId: string;
  row: HandoverRow;
  open: boolean;
  onToggle: () => void;
}) {
  /* The body is fetched only once a row is expanded, and kept for a
   * minute so collapsing and reopening does not refetch. */
  const body = useQuery({
    queryKey: ["lex-handover-file", anchorId, row.file],
    queryFn: () => lexHandoverFile(anchorId, row.file),
    enabled: open,
    staleTime: 60_000,
  });
  return (
    <li
      data-testid="handover-row"
      data-file={row.file}
      data-unvetted={row.unvetted ? "1" : "0"}
      className="rounded border border-border1 bg-surface1 p-2 text-xs"
    >
      <div className="flex items-center gap-2 font-mono text-nano text-txt3">
        <span className="text-txt2">{stamp(row.created_at)}</span>
        <span>{row.kind}</span>
        <span className={row.verdict ? "text-txt2" : "italic"}>
          {row.verdict ?? "no verdict"}
        </span>
        {row.unvetted && (
          <span
            data-testid="handover-unvetted"
            className="rounded-pill bg-warn/15 text-warn px-1.5 py-0.5 uppercase tracking-wider"
          >
            unvetted
          </span>
        )}
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="ml-auto rounded-pill bg-surface2 hairline px-2 py-0.5 text-txt2 hover:bg-surface3"
        >
          {open ? "collapse" : "expand"}
        </button>
      </div>
      <div className="font-mono text-nano text-txt3 truncate">{row.file}</div>
      {open &&
        (body.isLoading ? (
          <p className="mt-2 text-txt3">loading…</p>
        ) : body.data?.ok ? (
          <pre
            data-testid="handover-body"
            className="mt-2 whitespace-pre-wrap break-words rounded bg-surface2 p-2 font-mono text-nano text-txt2"
          >
            {body.data.content}
          </pre>
        ) : (
          <p className="mt-2 text-txt3">file unavailable.</p>
        ))}
    </li>
  );
}
