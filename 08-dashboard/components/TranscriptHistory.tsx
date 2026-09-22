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

/** Three-layer voice topology: the operator talks to the TOP (fast
 * voice) layer, which routes to the MID (deep reasoning / brainstorm
 * Lex) layer and back. Since 2026-09-22 (LAYER-1-CONTROL.md, one Lex)
 * the layer is kept on the row as data-layer for debugging only; every
 * assistant line reads "lex:" and renders flat. Absent =
 * legacy turn, labelled by role. */
export type TranscriptLayer = "operator" | "top" | "mid";

export interface TranscriptTurn {
  /** Stable id used as React key. Falls back to index when omitted. */
  id?: string;
  role: "user" | "assistant";
  text: string;
  layer?: TranscriptLayer;
  /** Layer 1 dropped this operator utterance (background noise or not
   * addressed to Lex). Rendered greyed with a "(not for Lex)" marker so
   * the operator can see what was dropped. */
  ignored?: boolean;
}

/* Speaker label per turn. Layer wins when present (three-way); role is
 * the back-compat fallback for turns emitted before the layer wiring. */
function turnLabel(t: TranscriptTurn): string {
  if (t.layer === "operator") return "you:";
  /* One Lex: the voice's spoken lines and the brain's reply text carry
   * the same label. The operator must never be able to tell there are
   * two layers behind the voice. */
  if (t.layer === "top" || t.layer === "mid") return "lex:";
  return t.role === "assistant" ? "lex:" : "you:";
}

function turnLabelClass(t: TranscriptTurn): string {
  if (t.layer === "operator" || (!t.layer && t.role === "user")) {
    return "text-txt3";
  }
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

  /* One row per turn (2026-09-22): the last maxTurns lines in order. */
  const groups = groupTranscriptTurns(turns).slice(-maxTurns);
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
          {groups.length === 0 && !showPlaceholder && (
            <div className="text-txt3">No transcript yet.</div>
          )}
          {groups.map((g) => {
            return (
              <div key={g.id} className="space-y-1">
                {g.row && (
                  /* An operator line Layer 1 dropped (background noise or
                   * not addressed to Lex) still shows, greyed, with a
                   * trailing "(not for Lex)" marker. Nothing was
                   * forwarded, so no voice or brain line follows it. */
                  <div
                    data-testid="lex-turn"
                    data-role={g.row.role}
                    data-layer={g.row.layer}
                    data-ignored={g.row.ignored ? "1" : undefined}
                    className="flex items-start gap-2"
                    style={g.row.ignored ? { opacity: 0.45 } : undefined}
                  >
                    <span
                      className={`text-nano font-mono mr-2 shrink-0 ${turnLabelClass(g.row)}`}
                    >
                      {turnLabel(g.row)}
                    </span>
                    <span className="text-txt1 flex-1 min-w-0 whitespace-pre-wrap">
                      {g.row.text}
                      {g.row.ignored && (
                        <span className="text-txt3 italic"> (not for Lex)</span>
                      )}
                    </span>
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
