"use client";

/**
 * Three-state supervision_mode toggle for a project anchor.
 *
 * polling — legacy cron supervision (opt-in fallback).
 * event   — daemon-driven push to Lex (the default).
 * off     — supervision disabled entirely (the kill-switch).
 *
 * Mounted on each ProjectsGrid tile that maps to a known anchor.
 * Optimistic update: the local control state flips on click, the
 * PATCH /projects/:id call is awaited, and on failure the state
 * rolls back to the prior value with a small error tooltip on the
 * button so the user sees why.
 *
 * Render-only consumers (tests) can drive every branch via the
 * onChange + initialMode + override patcher props.
 */
import { useCallback, useState } from "react";
import {
  patchProjectAnchor,
  type SupervisionMode,
} from "@/lib/daemon-client";

export type { SupervisionMode };

export interface SupervisionModeToggleProps {
  anchorId: string;
  initialMode: SupervisionMode;
  /** Notified after a successful change so the parent can revalidate
   * caches. */
  onChange?: (next: SupervisionMode) => void;
  /** Test seam: override the network call. */
  patcher?: typeof patchProjectAnchor;
  /** When true, the rendered control is read-only. Used by tests +
   * dormant anchors that should not be retoggled mid-flight. */
  disabled?: boolean;
}

const MODES: SupervisionMode[] = ["polling", "event", "off"];

const LABEL: Record<SupervisionMode, string> = {
  polling: "polling",
  event: "event",
  off: "off",
};

const TITLE: Record<SupervisionMode, string> = {
  polling: "Legacy cron supervision (opt-in fallback)",
  event: "Daemon-driven event supervision (default)",
  off: "Supervision disabled (kill-switch)",
};

/* Unified segmented control. All three modes share the same base
 * style; the active mode is rendered with a single fill + accent
 * border treatment regardless of which mode is active. Earlier
 * builds gave each mode a different active style (off=dim,
 * event=brand ring + inner dot, polling=plain fill), which made the
 * selection state ambiguous and conflated the event chip's selection
 * ring with its "live event just fired" pulse. */
function modeClass(mode: SupervisionMode, current: SupervisionMode): string {
  const base =
    "text-[11px] px-2 py-0.5 font-mono transition shrink-0 disabled:cursor-not-allowed";
  if (mode === current) {
    return `${base} bg-brand/15 text-brandSoft`;
  }
  return `${base} bg-transparent text-txt3 hover:bg-surface2/40`;
}

export function SupervisionModeToggle({
  anchorId,
  initialMode,
  onChange,
  patcher,
  disabled,
}: SupervisionModeToggleProps): React.ReactElement {
  const [mode, setMode] = useState<SupervisionMode>(initialMode);
  const [pending, setPending] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const callPatch = patcher ?? patchProjectAnchor;

  const handle = useCallback(
    async (next: SupervisionMode) => {
      if (disabled) return;
      if (pending) return;
      if (next === mode) return;
      const prev = mode;
      setMode(next);
      setPending(true);
      setError(null);
      try {
        const r = await callPatch(anchorId, { supervision_mode: next });
        if (!r.ok) {
          setMode(prev);
          setError(r.error ?? "patch refused");
          return;
        }
        onChange?.(next);
      } catch (err) {
        setMode(prev);
        setError((err as Error).message ?? "network error");
      } finally {
        setPending(false);
      }
    },
    [anchorId, callPatch, disabled, mode, onChange, pending],
  );

  return (
    <div
      data-testid="supervision-mode-toggle"
      data-mode={mode}
      data-pending={pending ? "1" : "0"}
      data-dim={mode === "off" ? "1" : "0"}
      className={`inline-flex items-center gap-1.5 min-w-0 max-w-full ${mode === "off" ? "opacity-60" : ""}`}
      title={error ? `error: ${error}` : TITLE[mode]}
    >
      <div
        role="radiogroup"
        aria-label="Supervision mode"
        className="inline-flex rounded-pill border border-border1 overflow-hidden shrink min-w-0"
      >
        {MODES.map((m) => (
          <button
            key={m}
            type="button"
            data-testid={`supervision-mode-${m}`}
            role="radio"
            aria-pressed={m === mode}
            aria-checked={m === mode}
            aria-label={`set supervision mode ${m}`}
            disabled={disabled || pending}
            onClick={() => void handle(m)}
            className={modeClass(m, mode)}
            title={TITLE[m]}
          >
            {LABEL[m]}
          </button>
        ))}
      </div>
      {/* Adjacent live-event pulse. Renders only when event-mode is
       * active. Kept OUTSIDE the segmented control so the chip's
       * selection treatment is the single source of truth for "which
       * mode is on" and this pulse is the single source of truth for
       * "an event just fired". The two concepts no longer conflate
       * in one glyph. */}
      {mode === "event" && (
        <span
          aria-hidden
          data-testid="supervision-event-indicator"
          className="inline-block w-1.5 h-1.5 rounded-full bg-brand shrink-0"
        />
      )}
    </div>
  );
}
