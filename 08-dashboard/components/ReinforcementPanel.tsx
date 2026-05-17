"use client";

import { useQuery } from "@tanstack/react-query";
import { reinforcement, type ReinforcementEvent } from "@/lib/daemon-client";
import { Icon } from "./Icon";

const KIND_LABEL: Record<ReinforcementEvent["kind"], string> = {
  injection: "injected",
  hit: "hit",
  "no-hit": "no hit",
  promote: "promoted",
  correction: "correction",
  "raw-hit": "raw hit",
  "raw-no-hit": "raw no hit",
  "raw-correction": "raw correction",
  "raw-hit-ingest": "raw hit -> ingest",
  "decay-archive": "decay archive",
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

function detail(e: ReinforcementEvent): string {
  const parts: string[] = [];
  if (typeof e.cosine === "number") parts.push(`cos ${e.cosine.toFixed(2)}`);
  if (typeof e.weight === "number") parts.push(`w ${e.weight.toFixed(2)}`);
  if (typeof e.pages_created === "number")
    parts.push(`+${e.pages_created} pages`);
  if (typeof e.pages_updated === "number" && e.pages_updated > 0)
    parts.push(`~${e.pages_updated} pages`);
  if (e.skipped_reason) parts.push(`skip: ${e.skipped_reason}`);
  if (e.source) parts.push(`src ${e.source}`);
  return parts.join(" · ");
}

export function ReinforcementPanel() {
  const q = useQuery({
    queryKey: ["reinforcement"],
    queryFn: () => reinforcement(50),
    refetchInterval: 5_000,
  });
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
          Every time Lex pulled a wiki page into a worker's context, scored by whether the page actually helped.
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
          raw transcript chunk and Claude responds, hit / no-hit / correction
          events will land here.
        </div>
      )}

      {events.length > 0 && (
        <ul className="divide-y divide-border2 max-h-96 overflow-y-auto">
          {events.map((e, i) => (
            <li key={`${e.ts}-${i}`} className="px-5 py-2 flex items-center gap-3 text-sm">
              <span className="text-[11px] font-mono text-txt3 w-10 shrink-0 text-right">
                {relTimeShort(e.ts)}
              </span>
              <span
                className={`text-xs font-emphasized w-32 shrink-0 ${KIND_COLOR[e.kind] ?? "text-txt2"}`}
              >
                {KIND_LABEL[e.kind] ?? e.kind}
              </span>
              <span className="text-xs font-mono text-txt2 truncate flex-1">
                {pageOrChunk(e)}
              </span>
              <span className="text-[11px] font-mono text-txt3 truncate hidden md:inline">
                {detail(e)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
