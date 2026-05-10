"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  lexSessionArtifacts,
  lexArtifact,
  type LexArtifactItem,
} from "@/lib/daemon-client";
import { relTime } from "@/lib/session-helpers";
import { Icon } from "./Icon";
import { LexThumbs } from "./LexThumbs";

interface Props {
  brainstormId: string | null;
  /* Whether the bound brainstorm row is still active. When active we
   * poll on a tight cadence so newly emitted artifacts appear without
   * the user having to refresh; once ended we relax the interval. */
  active: boolean;
}

const KIND_ICON: Record<string, "FileText" | "BookOpen" | "FolderPlus" | "ListChecks"> = {
  "research-note": "FileText",
  "wiki-draft": "BookOpen",
  "project-intent": "FolderPlus",
  "notes-summary": "ListChecks",
};

function iconFor(kind: string): "FileText" | "BookOpen" | "FolderPlus" | "ListChecks" {
  return KIND_ICON[kind] ?? "FileText";
}

function ArtifactRow({
  item,
  expanded,
  onToggle,
  promptVersion,
  brainstormId,
}: {
  item: LexArtifactItem;
  expanded: boolean;
  onToggle: () => void;
  promptVersion: string | null;
  brainstormId: string | null;
}) {
  const detailQ = useQuery({
    queryKey: ["lex-artifact", item.kind, item.id],
    queryFn: () => lexArtifact(item.kind, item.id),
    enabled: expanded,
    staleTime: 60_000,
  });
  const data = detailQ.data?.artifact?.data;
  const isWikiDraft = item.kind === "wiki-draft";
  return (
    <li className="border-b border-border2 last:border-b-0">
      <div className="w-full px-4 py-2.5 flex items-center gap-3 hover:bg-surface2/50">
        <button
          type="button"
          onClick={onToggle}
          className="flex-1 flex items-center gap-3 text-left min-w-0"
        >
          <Icon name={iconFor(item.kind)} size={14} className="text-brandSoft flex-shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="text-xs text-txt1 truncate">{item.title}</div>
            <div className="text-nano text-txt3 font-mono flex items-center gap-2">
              <span>{item.kind}</span>
              <span>{relTime(item.created_ms)} ago</span>
            </div>
          </div>
          <Icon
            name={expanded ? "ChevronUp" : "ChevronDown"}
            size={12}
            className="text-txt3 flex-shrink-0"
          />
        </button>
        {item.turn_id && promptVersion ? (
          <div className="flex-shrink-0">
            <LexThumbs
              turn_id={item.turn_id}
              prompt_version={promptVersion}
              brainstorm_id={brainstormId ?? null}
            />
          </div>
        ) : null}
      </div>
      {expanded && (
        <div className="px-4 pb-3 pt-1 bg-surface2/40">
          {detailQ.isLoading && (
            <div className="text-nano text-txt3 font-mono">loading…</div>
          )}
          {detailQ.isError && (
            <div className="text-nano text-err font-mono">failed to load</div>
          )}
          {data && (
            <>
              {isWikiDraft ? (
                <div className="space-y-2 text-xs text-txt2">
                  {typeof data.trigger === "string" && (
                    <div>
                      <div className="text-nano text-txt3 uppercase tracking-[0.16em]">
                        Trigger
                      </div>
                      <div className="font-mono">{data.trigger}</div>
                    </div>
                  )}
                  {typeof data.insight === "string" && (
                    <div>
                      <div className="text-nano text-txt3 uppercase tracking-[0.16em]">
                        Insight
                      </div>
                      <div>{data.insight}</div>
                    </div>
                  )}
                  {typeof data.summary === "string" && (
                    <div>
                      <div className="text-nano text-txt3 uppercase tracking-[0.16em]">
                        Summary
                      </div>
                      <div>{data.summary}</div>
                    </div>
                  )}
                  <div className="text-nano text-txt3 font-mono pt-2">
                    {item.path}
                  </div>
                </div>
              ) : (
                <pre className="text-nano text-txt2 font-mono whitespace-pre-wrap break-words max-h-80 overflow-y-auto">
                  {JSON.stringify(data, null, 2)}
                </pre>
              )}
            </>
          )}
          {!detailQ.isLoading && !data && (
            <pre className="text-nano text-txt3 font-mono whitespace-pre-wrap break-words">
              {item.preview}
            </pre>
          )}
        </div>
      )}
    </li>
  );
}

export function LexArtifactsPanel({ brainstormId, active }: Props) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ["lex-artifacts", brainstormId],
    queryFn: () => {
      if (!brainstormId) {
        return Promise.resolve({ ok: true as const, artifacts: [] });
      }
      return lexSessionArtifacts(brainstormId);
    },
    enabled: Boolean(brainstormId),
    refetchInterval: brainstormId ? (active ? 7_000 : 30_000) : false,
  });

  const items: LexArtifactItem[] = q.data?.artifacts ?? [];
  const promptVersion = q.data?.session_prompt_version ?? null;

  return (
    <div className="rounded-panel bg-surface1 hairline">
      <div className="px-5 py-3 border-b border-border1 flex items-center gap-2">
        <Icon name="Sparkles" className="text-brandSoft" size={16} />
        <h2 className="font-display text-sm font-emphasized">
          This session&apos;s artifacts
        </h2>
        <span className="text-nano text-txt3 ml-1">({items.length})</span>
      </div>
      {!brainstormId && (
        <div className="p-6 text-center text-xs text-txt3">
          No active brainstorm bound yet.
        </div>
      )}
      {brainstormId && q.isLoading && (
        <div className="p-4 space-y-2">
          {[0, 1].map((i) => (
            <div key={i} className="h-10 rounded-card bg-surface2 animate-pulse" />
          ))}
        </div>
      )}
      {brainstormId && !q.isLoading && items.length === 0 && (
        <div className="p-6 text-center text-xs text-txt3">
          No artifacts yet. Ask Lex to capture something.
        </div>
      )}
      {brainstormId && items.length > 0 && (
        <ul>
          {items.map((item) => (
            <ArtifactRow
              key={item.id}
              item={item}
              expanded={expandedId === item.id}
              onToggle={() =>
                setExpandedId((cur) => (cur === item.id ? null : item.id))
              }
              promptVersion={promptVersion}
              brainstormId={brainstormId}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
