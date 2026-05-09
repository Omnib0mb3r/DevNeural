"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { focusSession, sessions as sessionsClient, type SessionSummary } from "@/lib/daemon-client";
import { projectFromSlug, relTime } from "@/lib/session-helpers";
import { Icon } from "./Icon";
import { StatusDot } from "./StatusDot";
import { NavGrid } from "./NavGrid";
import { lexPickStable } from "@/lib/lex";

/* Stream Deck rail = remote analog of the physical Elgato deck.
 *
 * Two modes mirror the hardware exactly:
 *
 *   Grid (default) - one tile per active session. Tap a tile -> POST
 *   /sessions/:id/focus, bridge brings the matching VS Code window
 *   forward via SetForegroundWindow.
 *
 *   Nav - tap the same tile a second time within RETAP_WINDOW_MS while
 *   it's still the most-recently-focused. The rail collapses into the
 *   5x3 Nav grid (NavGrid.tsx), exactly like the hardware does. Each
 *   key press POSTs /sessions/:id/key and the bridge SendInputs into
 *   the focused window. Mic = Win+H. ✕ exits Nav back to Grid.
 *
 * "Already focused" detection is dashboard-local: we can't poll
 * GetForegroundWindow from the browser. Approximation: track the last
 * tile the user tapped + when. A second tap on the same tile within
 * RETAP_WINDOW_MS counts as "already focused, switching to nav." Click
 * a different tile while in Nav = focus that one + remain in Grid (so
 * the user can re-tap the new one to enter Nav for it). */

const STALE_HIDE_MS = 7 * 24 * 60 * 60 * 1000;
const RETAP_WINDOW_MS = 8_000;

type TileState =
  | "thinking"
  | "tool"
  | "permission"
  | "idle"
  | "inactive"
  | "stale";

function tileState(s: SessionSummary): TileState {
  if (!s.active) {
    if (Date.now() - s.last_modified_ms > STALE_HIDE_MS) return "stale";
    return "inactive";
  }
  if (s.phase === "permission") return "permission";
  if (s.phase === "thinking") return "thinking";
  if (s.phase === "tool") return "tool";
  return "idle";
}

function ledStatus(
  state: TileState,
): "live" | "ok" | "fail" | "ai" | "promoted" | "idle" {
  switch (state) {
    case "thinking":   return "ai";
    case "tool":       return "ok";
    case "permission": return "fail";
    case "idle":       return "live";
    case "inactive":   return "idle";
    case "stale":      return "idle";
  }
}

function ringClass(state: TileState): string {
  switch (state) {
    case "thinking":   return "ring-ai";
    case "tool":       return "ring-ok";
    case "permission": return "ring-warn";
    case "idle":       return "ring-live";
    default:           return "";
  }
}

export function StreamDeck() {
  const q = useQuery({
    queryKey: ["sessions"],
    queryFn: sessionsClient,
    refetchInterval: 5_000,
  });
  /* Default: show only sessions the daemon flags as active. The flag
   * uses a 24h jsonl-mtime window, so a live session stays visible
   * through normal idle gaps. Toggle pulls in older history when
   * the user wants to revisit a yesterday's transcript. */
  const [showStale, setShowStale] = useState(false);

  /* Last-focused tracker drives the "tap again to enter Nav" rule. */
  const [navSessionId, setNavSessionId] = useState<string | null>(null);
  const lastFocusRef = useRef<{ id: string; ts: number } | null>(null);

  const all: SessionSummary[] = q.data?.sessions ?? [];
  const active = all.filter((s) => s.active);
  const inactive = all.filter((s) => !s.active);
  const visible = [...(showStale ? all : active)].sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    return b.last_modified_ms - a.last_modified_ms;
  });

  /* Group by project_slug so multiple sessions in the same workspace
   * collapse under one header instead of looking like distinct projects. */
  const groups = (() => {
    const map = new Map<string, SessionSummary[]>();
    for (const s of visible) {
      const arr = map.get(s.project_slug) ?? [];
      arr.push(s);
      map.set(s.project_slug, arr);
    }
    return [...map.entries()]
      .map(([slug, sessions]) => ({
        slug,
        label: projectFromSlug(slug),
        sessions,
      }))
      .sort((a, b) => {
        const aMax = Math.max(...a.sessions.map((s) => s.last_modified_ms));
        const bMax = Math.max(...b.sessions.map((s) => s.last_modified_ms));
        return bMax - aMax;
      });
  })();

  const navSession =
    navSessionId != null ? all.find((s) => s.session_id === navSessionId) : null;

  function handleTileTap(s: SessionSummary, focusFn: () => void): void {
    const last = lastFocusRef.current;
    const now = Date.now();
    const isRetap =
      last != null && last.id === s.session_id && now - last.ts < RETAP_WINDOW_MS;
    if (isRetap) {
      // Same tile still recently focused -> enter Nav for it. No focus
      // request this time; the window is already in front.
      setNavSessionId(s.session_id);
      return;
    }
    // First tap (or different tile, or window expired) -> regular focus.
    setNavSessionId(null);
    lastFocusRef.current = { id: s.session_id, ts: now };
    focusFn();
  }

  // Auto-exit Nav if the underlying session disappears (process ended).
  useEffect(() => {
    if (navSessionId && !navSession) {
      setNavSessionId(null);
    }
  }, [navSessionId, navSession]);

  return (
    <aside className="w-64 flex-shrink-0 flex flex-col gap-3 p-4 hairline-soft border-r border-border2 overflow-y-auto">
      <div className="flex items-center justify-between mb-1">
        <div className="text-nano text-txt3">Stream deck</div>
        <span className="text-nano text-txt3 font-mono">
          {active.length} live
        </span>
      </div>

      {navSession ? (
        <NavGrid
          sessionId={navSession.session_id}
          projectLabel={
            navSession.user_label?.trim() ||
            navSession.derived_label?.trim() ||
            projectFromSlug(navSession.project_slug)
          }
          onClose={() => setNavSessionId(null)}
        />
      ) : (
        <>
          {q.isLoading && (
            <div className="space-y-2">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-20 rounded-card bg-surface1 animate-pulse" />
              ))}
            </div>
          )}

          {!q.isLoading && visible.length === 0 && (
            <div className="text-xs text-txt3 px-2 py-3">
              {lexPickStable("empty_sessions", "stream-deck-rail")}
            </div>
          )}

          {groups.map(({ slug, label, sessions }) => (
            <div key={slug} className="space-y-2">
              {sessions.length > 1 && (
                <div className="flex items-center justify-between px-1 pt-1">
                  <div className="text-nano text-txt2 font-emphasized">{label}</div>
                  <span className="text-nano text-txt3 font-mono">
                    {sessions.length} sessions
                  </span>
                </div>
              )}
              {sessions.map((s) => (
                <DeckTile key={s.session_id} session={s} onTap={handleTileTap} />
              ))}
            </div>
          ))}

          <a
            href="/sessions"
            className="w-full mt-1 lift p-3 rounded-card bg-surface1 hairline border-dashed text-txt2 hover:text-txt1 flex items-center justify-center gap-2 text-sm font-medium"
            aria-label="Manage sessions on the Sessions tab"
          >
            <Icon name="Plus" size={16} /> new session
          </a>

          <button
            type="button"
            onClick={() => q.refetch()}
            disabled={q.isFetching}
            className="w-full lift p-2 rounded-card bg-surface1 hairline text-txt3 hover:text-txt1 disabled:opacity-60 flex items-center justify-center gap-2 text-xs"
            aria-label="Refresh stream deck session list"
          >
            <Icon
              name="RefreshCw"
              size={16}
              className={q.isFetching ? "animate-spin" : undefined}
            />
            {q.isFetching ? "refreshing…" : "refresh"}
          </button>

          {inactive.length > 0 && (
            <button
              onClick={() => setShowStale((v) => !v)}
              className="text-nano text-txt3 hover:text-txt1 mt-1 px-2 py-1 text-left"
              aria-expanded={showStale}
            >
              {showStale
                ? `Hide ${inactive.length} idle`
                : `Show ${inactive.length} idle`}
            </button>
          )}

          {/* Hint for re-tap behavior so users discover Nav without docs. */}
          {visible.length > 0 && (
            <div className="text-nano text-txt3 px-2 pt-1">
              Tap to focus · tap again for Nav
            </div>
          )}
        </>
      )}
    </aside>
  );
}

interface DeckTileProps {
  session: SessionSummary;
  onTap: (s: SessionSummary, focusFn: () => void) => void;
}

function DeckTile({ session: s, onTap }: DeckTileProps) {
  const state = tileState(s);
  const led = ledStatus(state);
  const project = projectFromSlug(s.project_slug);
  /* Renames in the Past Sessions list set user_label on the brainstorm
   * row; daemon joins it onto every session item so the deck tile
   * reflects the user's title. derived_label is the LLM auto-name. */
  const tileLabel =
    s.user_label?.trim() || s.derived_label?.trim() || project;
  const ring = ringClass(state);
  const pulseOnLed =
    state === "thinking" ||
    state === "tool" ||
    state === "permission" ||
    state === "idle";
  const stateLabel =
    state === "thinking" ? "thinking" :
    state === "tool" ? "running tool" :
    state === "permission" ? "needs input" :
    state === "idle" ? "idle" :
    state === "inactive" ? "inactive" :
    "stale";
  const focusM = useMutation({
    mutationFn: () => focusSession(s.session_id),
  });
  return (
    <button
      type="button"
      onClick={() => onTap(s, () => focusM.mutate())}
      disabled={focusM.isPending}
      className={`w-full block text-left p-3 rounded-card bg-surface1 hairline lift transition-shadow ${ring} ${
        focusM.isPending ? "ring-1 ring-brand/60" : ""
      }`}
      aria-label={`Focus VS Code window for ${tileLabel} (${state}). Tap again to enter nav mode.`}
    >
      <div className="flex items-center justify-between mb-1.5">
        <div className="font-display text-sm font-emphasized truncate text-txt1">
          {tileLabel}
        </div>
        <StatusDot status={led} pulse={pulseOnLed} />
      </div>
      <div className="text-xs text-txt2 font-mono mb-1">{stateLabel}</div>
      <div className="flex items-center justify-between text-[11px] font-mono text-txt3">
        <span className="truncate">{s.session_id.slice(0, 8)}</span>
        <span className="flex items-center gap-2">
          <span>
            {focusM.isPending
              ? "focusing…"
              : focusM.isSuccess
                ? "focused ✓"
                : `last ${relTime(s.last_modified_ms)} ago`}
          </span>
          {s.has_task && <Icon name="ListTodo" size={11} />}
          {s.has_summary && <Icon name="ScrollText" size={11} />}
        </span>
      </div>
    </button>
  );
}
