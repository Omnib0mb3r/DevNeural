"use client";

/**
 * LEX-AUTONOMY codex 10c (Fix 47 step 3): LooseEndsBanner.
 *
 * Renders the structured `loose_ends` payload returned by 409 responses
 * from POST /projects/:id/start-claude (and any other spawn / handoff
 * route that surfaces a loose-ends gate decision). The banner has
 * three responsibilities:
 *
 *   1. Per-class one-liner: each loose end becomes a row with its
 *      class (rendered human-friendly), disposition tag, and the
 *      detail string the gate produced.
 *   2. Severity color: the highest severity end drives the banner
 *      color (alert/warn/info). Per-row pills carry their own
 *      severity so the operator sees the breakdown at a glance.
 *   3. Dismiss + 5-min anchor mute: dismiss writes the anchor id to
 *      localStorage with a TTL stamp so the dashboard can suppress
 *      re-fires for that anchor within the window. Surfaces should
 *      call isLooseEndsBannerDismissed(anchorId) before rendering.
 *
 * Pure component: the parent owns the loose-ends payload (typically
 * from a TanStack Query mutation result) and chooses when to render.
 * The dismiss persistence is local-only; the backend gate fires on
 * its own schedule.
 */
import { useState, type ReactElement } from "react";

export type LooseEndSeverity = "info" | "warn" | "alert";
export type LooseEndDisposition = "auto" | "operator" | "informational";

export interface LooseEndReportEntry {
  class: string;
  disposition: LooseEndDisposition;
  severity: LooseEndSeverity;
  detail: string;
  evidence_ref_id?: number | null;
  evidence_cc_session_id?: string | null;
}

export interface LooseEndsReportShape {
  anchor_id: string;
  ends: LooseEndReportEntry[];
  has_blocker: boolean;
  has_auto: boolean;
  generated_ms: number;
}

export interface LooseEndsBannerProps {
  report: LooseEndsReportShape;
  /** Called after dismiss writes the local mute entry; parents
   * typically hide the banner. */
  onDismiss?: () => void;
}

const DISMISS_TTL_MS = 5 * 60 * 1000;
const DISMISS_STORAGE_KEY = "devneural.looseEnds.dismissed";

const SEVERITY_RANK: Record<LooseEndSeverity, number> = {
  alert: 3,
  warn: 2,
  info: 1,
};

const SEVERITY_BANNER_CLASS: Record<LooseEndSeverity, string> = {
  alert: "border-rose-500/70 bg-rose-950/40 text-rose-100",
  warn: "border-amber-500/70 bg-amber-950/30 text-amber-100",
  info: "border-sky-500/70 bg-sky-950/30 text-sky-100",
};

const SEVERITY_PILL_CLASS: Record<LooseEndSeverity, string> = {
  alert: "bg-rose-500/30 text-rose-100",
  warn: "bg-amber-500/30 text-amber-100",
  info: "bg-sky-500/30 text-sky-100",
};

function humanizeClass(c: string): string {
  return c
    .split("_")
    .map((s) => (s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1)))
    .join(" ");
}

interface DismissEntry {
  anchor_id: string;
  expires_ms: number;
}

function readDismissTable(): DismissEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(DISMISS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as DismissEntry[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e) =>
        e &&
        typeof e.anchor_id === "string" &&
        typeof e.expires_ms === "number",
    );
  } catch {
    return [];
  }
}

function writeDismissTable(rows: DismissEntry[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(DISMISS_STORAGE_KEY, JSON.stringify(rows));
  } catch {
    /* storage may be disabled; silent no-op */
  }
}

/* Exported so spawn surfaces can ask "should I render the banner?"
 * without re-deriving the storage shape. Expired entries are pruned
 * on read so the dismiss table cannot grow unbounded across long-
 * lived dashboard sessions. */
export function isLooseEndsBannerDismissed(anchorId: string): boolean {
  if (!anchorId) return false;
  const now = Date.now();
  const rows = readDismissTable();
  const live = rows.filter((e) => e.expires_ms > now);
  if (live.length !== rows.length) writeDismissTable(live);
  return live.some((e) => e.anchor_id === anchorId);
}

export function dismissLooseEndsBanner(anchorId: string): void {
  if (!anchorId) return;
  const now = Date.now();
  const rows = readDismissTable().filter((e) => e.expires_ms > now);
  const next = rows.filter((e) => e.anchor_id !== anchorId);
  next.push({ anchor_id: anchorId, expires_ms: now + DISMISS_TTL_MS });
  writeDismissTable(next);
}

export function LooseEndsBanner(props: LooseEndsBannerProps): ReactElement | null {
  const { report } = props;
  const [hidden, setHidden] = useState(false);
  if (hidden) return null;
  if (!report || !Array.isArray(report.ends) || report.ends.length === 0) {
    return null;
  }
  /* Highest-severity end drives the banner color. Sort copy so the
   * prop array stays immutable; the gate already sorts severity DESC
   * but the component must not assume that. */
  const sorted = [...report.ends].sort(
    (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity],
  );
  const topSeverity: LooseEndSeverity = sorted[0]?.severity ?? "info";
  function onDismissClick(): void {
    dismissLooseEndsBanner(report.anchor_id);
    setHidden(true);
    props.onDismiss?.();
  }
  return (
    <div
      role="alert"
      data-testid="loose-ends-banner"
      className={`border rounded-lg px-4 py-3 ${SEVERITY_BANNER_CLASS[topSeverity]}`}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <span className="font-semibold">Loose ends blocking spawn</span>
          <span className="text-xs opacity-75">
            anchor {report.anchor_id.slice(0, 8)}
          </span>
        </div>
        <button
          type="button"
          onClick={onDismissClick}
          className="text-xs underline opacity-80 hover:opacity-100"
          data-testid="loose-ends-banner-dismiss"
        >
          Dismiss for 5 min
        </button>
      </div>
      <ul className="mt-2 space-y-1 text-sm">
        {sorted.map((end, idx) => (
          <li
            key={`${end.class}-${idx}`}
            className="flex items-start gap-2"
            data-testid="loose-ends-banner-row"
          >
            <span
              className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${SEVERITY_PILL_CLASS[end.severity]}`}
            >
              {end.severity}
            </span>
            <span className="font-medium">{humanizeClass(end.class)}</span>
            <span className="text-xs opacity-75">({end.disposition})</span>
            <span className="opacity-80">- {end.detail}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
