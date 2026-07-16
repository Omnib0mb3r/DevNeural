"use client";

/**
 * Wiki match history (reinforcement log tail).
 *
 * 2026-07-16 operator audit rework: the table used to show jargon
 * ("cos 0.45", "src raw"), had no column headers, and rows were dead.
 * Now: column headers, plain-English labels + details, and each row
 * expands to a verdict sentence (sent / accepted / not used /
 * rejected) plus the injected preview when the daemon logged one.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { reinforcement, type ReinforcementEvent } from "@/lib/daemon-client";
import { Icon } from "./Icon";

const KIND_LABEL: Record<ReinforcementEvent["kind"], string> = {
  injection: "sent to worker",
  hit: "match used",
  "no-hit": "match unused",
  promote: "promoted",
  correction: "corrected",
  "raw-hit": "match used",
  "raw-no-hit": "match unused",
  "raw-correction": "corrected",
  "raw-hit-ingest": "queued for wiki",
  "decay-archive": "archived (decay)",
  archive: "archived",
};

const KIND_COLOR: Record<ReinforcementEvent["kind"], string> = {
  injection: "text-brandSoft",
  hit: "text-promoted",
  "no-hit": "text-txt3",
  promote: "text-promoted",
  correction: "text-warn",
  "raw-hit": "text-promoted",
  "raw-no-hit": "text-txt3",
  "raw-correction": "text-warn",
  "raw-hit-ingest": "text-ai",
  "decay-archive": "text-txt3",
  archive: "text-txt3",
};

/* One-sentence verdict per kind for the expanded row. States plainly
 * whether the match was accepted or rejected and what happened next. */
const KIND_VERDICT: Record<ReinforcementEvent["kind"], string> = {
  injection:
    "Sent: this content was injected into the worker's context. The next hit / unused event for the same page shows whether it helped.",
  hit: "Accepted: the worker's reply drew on the injected wiki page, so its weight was raised.",
  "no-hit":
    "Not used: the worker's reply didn't draw on the injected wiki page, so its weight decayed a little.",
  promote:
    "Promoted: repeated hits carried this page to canonical status.",
  correction:
    "Rejected: the reply contradicted the injected wiki page, so its weight was lowered.",
  "raw-hit":
    "Accepted: the reply drew on the injected transcript chunk; it is now a candidate for wiki distillation.",
  "raw-no-hit":
    "Not used: the reply didn't draw on the injected transcript chunk, so it decayed a little.",
  "raw-correction":
    "Rejected: the reply contradicted the injected transcript chunk, so it was demoted.",
  "raw-hit-ingest":
    "Used enough that this transcript chunk was queued to become a wiki page.",
  "decay-archive":
    "Archived: the weight decayed to the floor with no recent hits.",
  archive: "Archived.",
};

function relTimeShort(iso: string): string {
  const t = Date.parse(iso);
  if (!t) return "—";
  const ms = Date.now() - t;
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

function pageOrChunk(e: ReinforcementEvent): string {
  if (e.page) return e.page;
  if (e.chunk) return e.chunk.slice(0, 16);
  return "";
}

function sourceLabel(source: ReinforcementEvent["source"]): string | null {
  if (source === "wiki") return "wiki page";
  if (source === "raw") return "transcript chunk";
  return null;
}

function detail(e: ReinforcementEvent): string {
  const parts: string[] = [];
  if (typeof e.cosine === "number")
    parts.push(`similarity ${e.cosine.toFixed(2)}`);
  if (typeof e.weight === "number") parts.push(`weight ${e.weight.toFixed(2)}`);
  if (typeof e.pages_created === "number")
    parts.push(`+${e.pages_created} pages`);
  if (typeof e.pages_updated === "number" && e.pages_updated > 0)
    parts.push(`~${e.pages_updated} pages`);
  if (e.skipped_reason) parts.push(`skipped: ${e.skipped_reason}`);
  const src = sourceLabel(e.source);
  if (src) parts.push(src);
  return parts.join(" · ");
}

export function ReinforcementPanel() {
  const q = useQuery({
    queryKey: ["reinforcement"],
    queryFn: () => reinforcement(50),
    refetchInterval: 5_000,
  });
  const [expanded, setExpanded] = useState<string | null>(null);
  const events = q.data?.events ?? [];

  return (
    <section className="rounded-panel bg-surface1 hairline overflow-hidden">
      <div className="px-5 py-3 border-b border-border1 flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <Icon name="Activity" className="text-brandSoft" size={16} />
          <h2 className="font-display text-sm font-emphasized">
            Wiki match history
          </h2>
          <span className="text-nano text-txt3 ml-auto">
            {events.length} of{" "}
            {q.data?.total_bytes ? `${Math.round((q.data.total_bytes / 1024) * 10) / 10} KB` : "0 KB"}
          </span>
        </div>
        <p className="text-nano text-txt3">
          Every time a wiki page or transcript chunk was injected into a worker&apos;s context, and whether it actually helped. Click a row for the verdict and what was sent.
        </p>
      </div>

      {q.isLoading && (
        <div className="p-5 space-y-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-6 rounded-card bg-surface2 animate-pulse" />
          ))}
        </div>
      )}

      {!q.isLoading && events.length === 0 && (
        <div className="p-5 text-sm text-txt3">
          No reinforcement events yet. Once the curator injects a wiki page or
          raw transcript chunk and Claude responds, used / unused / corrected
          events will land here.
        </div>
      )}

      {events.length > 0 && (
        <ul className="divide-y divide-border2 max-h-96 overflow-y-auto">
          <li
            aria-hidden
            data-testid="reinforcement-headers"
            className="px-5 py-1.5 flex items-center gap-3 text-[10px] uppercase tracking-wider text-txt3 sticky top-0 bg-surface1"
          >
            <span className="w-10 shrink-0 text-right">when</span>
            <span className="w-32 shrink-0">what happened</span>
            <span className="flex-1">matched page / chunk</span>
            <span className="hidden md:inline">details</span>
          </li>
          {events.map((e, i) => {
            const rowId = `${e.ts}-${i}`;
            const isOpen = expanded === rowId;
            return (
              <li
                key={rowId}
                data-testid="reinforcement-row"
                className="text-sm"
              >
                <button
                  type="button"
                  aria-expanded={isOpen}
                  onClick={() => setExpanded(isOpen ? null : rowId)}
                  className="w-full px-5 py-2 flex items-center gap-3 text-left hover:bg-surface2/40"
                >
                  <span className="text-[11px] font-mono text-txt3 w-10 shrink-0 text-right">
                    {relTimeShort(e.ts)}
                  </span>
                  <span
                    className={`text-xs font-emphasized w-32 shrink-0 ${KIND_COLOR[e.kind] ?? "text-txt2"}`}
                    title={e.kind}
                  >
                    {KIND_LABEL[e.kind] ?? e.kind}
                  </span>
                  <span className="text-xs font-mono text-txt2 truncate flex-1">
                    {pageOrChunk(e)}
                  </span>
                  <span className="text-[11px] font-mono text-txt3 truncate hidden md:inline">
                    {detail(e)}
                  </span>
                </button>
                {isOpen && (
                  <div
                    data-testid="reinforcement-row-body"
                    className="px-5 pb-3 pt-1 space-y-2 text-xs"
                  >
                    <p className="text-txt2">
                      {KIND_VERDICT[e.kind] ?? ""}
                    </p>
                    {e.preview && (
                      <div>
                        <div className="text-nano text-txt3 uppercase tracking-wider mb-1">
                          what was injected
                        </div>
                        <div className="font-mono text-[11px] text-txt2 whitespace-pre-wrap bg-surface2/40 rounded-card p-2">
                          {e.preview}
                        </div>
                      </div>
                    )}
                    <div className="text-nano text-txt3 font-mono">
                      {e.session ? `session ${e.session.slice(0, 8)}` : null}
                      {typeof e.cosine === "number"
                        ? ` · similarity ${e.cosine.toFixed(2)}`
                        : null}
                    </div>
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
