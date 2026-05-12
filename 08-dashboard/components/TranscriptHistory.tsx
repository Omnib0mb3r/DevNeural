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

export interface TranscriptTurn {
  /** Stable id used as React key. Falls back to index when omitted. */
  id?: string;
  role: "user" | "assistant";
  text: string;
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

  const rendered = turns.slice(-maxTurns);
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
          {rendered.map((t, i) => (
            <div
              key={t.id ?? `${t.role}-${i}`}
              data-testid="lex-turn"
              data-role={t.role}
              className="flex items-start gap-2"
            >
              <span
                className={`text-nano font-mono mr-2 ${
                  t.role === "assistant" ? "text-brandSoft" : "text-txt3"
                }`}
              >
                {t.role === "assistant" ? "lex:" : "you:"}
              </span>
              <span className="text-txt1 flex-1 min-w-0 whitespace-pre-wrap">
                {t.text}
              </span>
            </div>
          ))}
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
