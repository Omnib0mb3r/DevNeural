"use client";

/**
 * Lex transcript history panel.
 *
 * Renders the last N turns from an in-memory turn list (newest first
 * after slicing), surfaces a "Lex is thinking" placeholder when the
 * voice client reports status='thinking', and persists its
 * collapsed / expanded state in localStorage so a page reload does
 * not whip the panel back open against the user's preference.
 *
 * Pure render component: every input comes through props, every
 * side effect (localStorage write) goes through the
 * lib/transcript-collapse helpers so the surface stays test-friendly.
 */
import { useEffect, useState } from "react";
import {
  readCollapsedState,
  writeCollapsedState,
} from "@/lib/transcript-collapse";
import { groupTranscriptTurns } from "@/lib/transcript-grouping";

/** Three-layer voice topology (2026-07-18): the operator talks to the
 * TOP (fast voice) layer, which routes to the MID (deep reasoning /
 * brainstorm Lex) layer and back. The transcript labels each turn by
 * the layer it came from so the round trip (you -> voice -> deep -> and
 * back) is legible, not flattened to a two-party you/lex log. Absent =
 * legacy turn, labelled by role. */
export type TranscriptLayer = "operator" | "top" | "mid";

export interface TranscriptTurn {
  /** Stable id used as React key. Falls back to index when omitted. */
  id?: string;
  role: "user" | "assistant";
  text: string;
  layer?: TranscriptLayer;
}

/* Speaker label per turn. Layer wins when present (three-way); role is
 * the back-compat fallback for turns emitted before the layer wiring. */
function turnLabel(t: TranscriptTurn): string {
  if (t.layer === "operator") return "you:";
  if (t.layer === "top") return "lex (voice):";
  if (t.layer === "mid") return "lex (deep):";
  return t.role === "assistant" ? "lex:" : "you:";
}

function turnLabelClass(t: TranscriptTurn): string {
  if (t.layer === "operator" || (!t.layer && t.role === "user")) {
    return "text-txt3";
  }
  /* top = fast voice throat, mid = deep reasoning. Both are Lex; tint
   * the fast layer lighter so the two are distinguishable at a glance. */
  if (t.layer === "top") return "text-txt2";
  return "text-brandSoft";
}

export interface TranscriptHistoryProps {
  turns: TranscriptTurn[];
  /** How many trailing turns to render. Defaults to 10. */
  maxTurns?: number;
  /** Voice client status. 'thinking' renders the placeholder. */
  status?: "thinking" | string;
  /** Test seam: override the initial collapsed read. */
  initialCollapsed?: boolean;
  /** Test seam: receive every persistence write. */
  onPersist?: (collapsed: boolean) => void;
}

const DEFAULT_MAX_TURNS = 10;

export function TranscriptHistory({
  turns,
  maxTurns = DEFAULT_MAX_TURNS,
  status,
  initialCollapsed,
  onPersist,
}: TranscriptHistoryProps): React.ReactElement {
  const [collapsed, setCollapsed] = useState<boolean>(
    initialCollapsed ?? false,
  );
  /* P4: which deep (MID) step-down nodes are expanded, keyed by group
   * id. Collapsed by default - the deep reply is troubleshooting detail
   * under the voice line, revealed on demand. */
  const [expandedDeep, setExpandedDeep] = useState<Set<string>>(
    () => new Set<string>(),
  );

  function toggleDeep(id: string): void {
    setExpandedDeep((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /* Read persisted state on mount when the caller did not pre-seed
   * via initialCollapsed. SSR-safe: readCollapsedState bails when
   * window is undefined. */
  useEffect(() => {
    if (initialCollapsed !== undefined) return;
    setCollapsed(readCollapsedState());
  }, [initialCollapsed]);

  function toggle(): void {
    setCollapsed((prev) => {
      const next = !prev;
      writeCollapsedState(next);
      onPersist?.(next);
      return next;
    });
  }

  const rendered = turns.slice(-maxTurns);
  /* P4: fold deep (MID) turns under their voice line so the transcript
   * reads as a two-party operator <-> VOICE conversation. */
  const groups = groupTranscriptTurns(rendered);
  const showPlaceholder = status === "thinking";

  return (
    <section
      data-testid="lex-transcript-history"
      data-collapsed={collapsed ? "1" : "0"}
      className="rounded-panel bg-surface1 hairline"
    >
      <header className="px-4 py-2.5 border-b border-border1 flex items-center justify-between">
        <h2 className="text-sm font-emphasized text-txt1">Transcript</h2>
        <div className="flex items-center gap-2">
          <span className="text-nano text-txt3 uppercase tracking-wider">
            {`last ${maxTurns}`}
          </span>
          <button
            type="button"
            onClick={toggle}
            aria-expanded={!collapsed}
            aria-controls="lex-transcript-body"
            className="text-[11px] px-2 py-0.5 rounded-pill hairline font-emphasized bg-surface2 text-txt2 hover:bg-surface3"
          >
            {collapsed ? "expand" : "collapse"}
          </button>
        </div>
      </header>
      {!collapsed && (
        <div id="lex-transcript-body" className="px-5 py-3 space-y-2 text-xs">
          {rendered.length === 0 && !showPlaceholder && (
            <div className="text-txt3">No transcript yet.</div>
          )}
          {groups.map((g, gi) => {
            const deepOpen = expandedDeep.has(g.id);
            return (
              <div key={g.id} className="space-y-1">
                {g.row && (
                  <div
                    data-testid="lex-turn"
                    data-role={g.row.role}
                    data-layer={g.row.layer}
                    className="flex items-start gap-2"
                  >
                    <span
                      className={`text-nano font-mono mr-2 shrink-0 ${turnLabelClass(g.row)}`}
                    >
                      {turnLabel(g.row)}
                    </span>
                    <span className="text-txt1 flex-1 min-w-0 whitespace-pre-wrap">
                      {g.row.text}
                    </span>
                  </div>
                )}
                {g.deep.length > 0 && (
                  /* Thin COLLAPSED deep step-down node under the voice
                   * line. Never a bubble that addresses the operator;
                   * the deep text is hidden until expanded. */
                  <div className="pl-[3.25rem]">
                    <button
                      type="button"
                      data-testid="lex-deep-toggle"
                      onClick={() => toggleDeep(g.id)}
                      aria-expanded={deepOpen}
                      aria-controls={`lex-deep-body-${gi}`}
                      className="flex items-center gap-1 text-nano text-txt3 hover:text-txt2 font-mono"
                    >
                      <span aria-hidden="true">{deepOpen ? "▾" : "▸"}</span>
                      <span>
                        deep replied
                        {g.deep.length > 1 ? ` (${g.deep.length})` : ""}
                      </span>
                    </button>
                    {deepOpen && (
                      <div
                        id={`lex-deep-body-${gi}`}
                        data-testid="lex-deep-body"
                        className="mt-1 pl-3 border-l border-border1 space-y-1 text-txt2"
                      >
                        {g.deep.map((d, di) => (
                          <div
                            key={d.id ?? `deep-${di}`}
                            data-testid="lex-deep-line"
                            className="whitespace-pre-wrap"
                          >
                            {d.text}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {showPlaceholder && (
            <div
              data-testid="lex-thinking-placeholder"
              className="flex items-center gap-2 text-txt3 italic"
            >
              <span className="text-nano text-brandSoft font-mono mr-2">
                lex:
              </span>
              <span>Lex is thinking…</span>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
