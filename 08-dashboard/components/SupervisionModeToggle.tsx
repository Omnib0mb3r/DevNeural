"use client";

/**
 * Three-state supervision_mode toggle for a project anchor.
 *
 * polling — legacy cron supervision (default).
 * event   — daemon-driven push to Lex (newer pipeline).
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
  polling: "Legacy cron supervision (default)",
  event: "Daemon-driven event supervision (newer pipeline)",
  off: "Supervision disabled (kill-switch)",
};

function modeClass(mode: SupervisionMode, current: SupervisionMode): string {
  const base =
    "text-[11px] px-2 py-0.5 font-mono rounded-pill border transition";
  if (mode !== current) {
    return `${base} border-border1 bg-surface2 text-txt3 hover:bg-surface3`;
  }
  if (mode === "off") {
    return `${base} border-txt3/30 bg-surface3 text-txt3`;
  }
  if (mode === "event") {
    return `${base} border-brand/40 bg-brand/10 text-brandSoft ring-1 ring-brand/30`;
  }
  return `${base} border-border1 bg-surface3 text-txt1`;
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
      className={`inline-flex items-center gap-1 ${mode === "off" ? "opacity-60" : ""}`}
      title={error ? `error: ${error}` : TITLE[mode]}
    >
      {MODES.map((m) => (
        <button
          key={m}
          type="button"
          data-testid={`supervision-mode-${m}`}
          aria-pressed={m === mode}
          aria-label={`set supervision mode ${m}`}
          disabled={disabled || pending}
          onClick={() => void handle(m)}
          className={modeClass(m, mode)}
          title={TITLE[m]}
        >
          {LABEL[m]}
          {m === "event" && mode === "event" && (
            <span
              aria-hidden
              data-testid="supervision-event-indicator"
              className="ml-1 inline-block w-1.5 h-1.5 rounded-full bg-brand"
            />
          )}
        </button>
      ))}
    </div>
  );
}
