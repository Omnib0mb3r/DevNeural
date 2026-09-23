"use client";

/**
 * Context gauge (2026-09-22 plan, Task 10).
 *
 * One shape on every session surface: a bar filled to the session's
 * context percent with two vertical marks at the smart-clear threshold
 * (early wind-down) and ceiling (force stop). Colour follows the marks:
 * ok below the threshold, warn between, alarm at or above the ceiling.
 * A null percent reads "context unknown" and draws no fill; the marks
 * still show where the trips sit. The colour classes gauge-ok,
 * gauge-warn, gauge-alarm and gauge-unknown ride on the root so a
 * stylesheet or a test can key on them.
 */

export interface ContextGaugeProps {
  /** Whole percent of the context window, or null when unknown. */
  pct: number | null;
  /** Smart-clear early wind-down mark. */
  thresholdPct: number;
  /** Smart-clear force-stop mark. */
  ceilingPct: number;
  /** Optional prefix for the reading and the meter's accessible name. */
  label?: string;
  /** Dense variant for table rows and nested tiles. */
  compact?: boolean;
}

export type GaugeTone = "ok" | "warn" | "alarm" | "unknown";

function clampPct(v: number): number {
  return Math.max(0, Math.min(100, Math.round(v)));
}

function known(pct: number | null): pct is number {
  return pct !== null && Number.isFinite(pct);
}

/** Which colour the gauge takes for a reading against the two marks. */
export function gaugeTone(
  pct: number | null,
  thresholdPct: number,
  ceilingPct: number,
): GaugeTone {
  if (!known(pct)) return "unknown";
  if (pct >= ceilingPct) return "alarm";
  if (pct >= thresholdPct) return "warn";
  return "ok";
}

/** The one-line reading under the bar. */
export function gaugeReading(pct: number | null, thresholdPct: number): string {
  if (!known(pct)) return "context unknown";
  return `${clampPct(pct)}% of context, clears at ${thresholdPct}%`;
}

const FILL_CLASS: Record<GaugeTone, string> = {
  ok: "bg-ok",
  warn: "bg-warn",
  alarm: "bg-err",
  unknown: "bg-txt4",
};

const TEXT_CLASS: Record<GaugeTone, string> = {
  ok: "text-txt3",
  warn: "text-warn",
  alarm: "text-err",
  unknown: "text-txt3",
};

export function ContextGauge({
  pct,
  thresholdPct,
  ceilingPct,
  label,
  compact = false,
}: ContextGaugeProps) {
  const tone = gaugeTone(pct, thresholdPct, ceilingPct);
  const fill = known(pct) ? clampPct(pct) : 0;
  const reading = gaugeReading(pct, thresholdPct);
  const name = label ? `${label} context` : "context";
  return (
    <div
      data-testid="context-gauge"
      data-tone={tone}
      data-compact={compact ? "1" : "0"}
      className={`context-gauge gauge-${tone} ${compact ? "space-y-0.5" : "space-y-1"}`}
      role="meter"
      aria-label={name}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={known(pct) ? fill : undefined}
      aria-valuetext={reading}
    >
      <div
        className={`relative w-full overflow-hidden rounded-pill bg-surface2 ${
          compact ? "h-1" : "h-1.5"
        }`}
      >
        <div
          data-testid="context-gauge-fill"
          className={`absolute inset-y-0 left-0 rounded-pill ${FILL_CLASS[tone]}`}
          style={{ width: `${fill}%` }}
        />
        <span
          data-testid="context-gauge-threshold"
          aria-hidden="true"
          className="absolute inset-y-0 w-px bg-warn"
          style={{ left: `${clampPct(thresholdPct)}%` }}
        />
        <span
          data-testid="context-gauge-ceiling"
          aria-hidden="true"
          className="absolute inset-y-0 w-px bg-err"
          style={{ left: `${clampPct(ceilingPct)}%` }}
        />
      </div>
      <div
        data-testid="context-gauge-text"
        className={`font-mono ${compact ? "text-[10px]" : "text-nano"} ${TEXT_CLASS[tone]}`}
      >
        {label ? `${label}: ${reading}` : reading}
      </div>
    </div>
  );
}
