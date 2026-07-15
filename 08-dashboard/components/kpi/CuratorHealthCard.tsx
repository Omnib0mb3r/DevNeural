"use client";

/**
 * Curator Health KPI card (CI-6).
 *
 * Sparkline of injections per day across a rolling 7-day window
 * plus the four headline rates (hit, correction, silence, click)
 * and a canary status pill. Slots into the KpiStrip Quality row
 * additively; existing tiles untouched.
 *
 * Shape and units match daemon endpoint GET /stats/curator-health
 * (PHASE-TWO-IMPLEMENTATION.md section 4.1). Polling cadence
 * mirrors the rest of the strip (30s) so the card refreshes in
 * lockstep with the other KPIs without stacking extra requests.
 */
import { useQuery } from "@tanstack/react-query";
import {
  statsCuratorHealth,
  type CuratorHealthStats,
} from "@/lib/daemon-client";
import { Icon } from "../Icon";
import { Card } from "../ui/Card";

const WINDOW_DAYS = 7;
const SPARK_W = 88;
const SPARK_H = 28;

function Sparkline({ values }: { values: number[] }) {
  if (values.length === 0) {
    return <div className="h-7 w-[88px]" aria-hidden />;
  }
  const max = Math.max(1, ...values);
  const stepX = values.length > 1 ? SPARK_W / (values.length - 1) : 0;
  const points = values
    .map((v, i) => {
      const x = i * stepX;
      const y = SPARK_H - (v / max) * SPARK_H;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const last = values[values.length - 1] ?? 0;
  const lastY = SPARK_H - (last / max) * SPARK_H;
  return (
    <svg
      width={SPARK_W}
      height={SPARK_H}
      viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
      className="text-brandSoft"
      aria-label={`Injections per day, last ${values.length} days`}
    >
      <polyline
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
        points={points}
        opacity="0.85"
      />
      <circle cx={SPARK_W} cy={lastY} r="2" fill="currentColor" />
    </svg>
  );
}

function pct(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(0)}%`;
}

function CanaryPill({ status }: { status: CuratorHealthStats["canary_status"] }) {
  /* The daemon always returns 'unknown' for canary_status right now (no
   * canary probe wired up yet on that side - out of scope for this UI
   * fix). Rendering that as an amber "canary —" pill implies a real,
   * currently-indeterminate health check exists. It doesn't, so say so
   * plainly instead of dressing up a stub as a live status. */
  if (status !== "green" && status !== "red") {
    return (
      <span
        className="text-nano px-1.5 py-0.5 rounded border border-border2 text-txt3 font-mono uppercase tracking-wider"
        title="No canary probe is wired up on the daemon yet."
      >
        canary: not wired
      </span>
    );
  }
  const cls =
    status === "green"
      ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
      : "bg-rose-500/15 text-rose-300 border-rose-500/30";
  const label = status === "green" ? "canary green" : "canary red";
  return (
    <span
      className={`text-nano px-1.5 py-0.5 rounded border font-mono uppercase tracking-wider ${cls}`}
    >
      {label}
    </span>
  );
}

export function CuratorHealthCard() {
  const q = useQuery<CuratorHealthStats>({
    queryKey: ["stats-curator-health", WINDOW_DAYS],
    queryFn: () => statsCuratorHealth(WINDOW_DAYS),
    refetchInterval: 30_000,
    staleTime: 15_000,
    /* Wave 1 ships the endpoint but no real curator decisions
     * accumulate until a Lex session runs against the new
     * daemon. The card stays in the strip with placeholder
     * values until then; a fetch error renders an em-dash row
     * rather than tearing the whole strip down. */
    retry: 0,
  });
  const d = q.data;
  const total =
    d?.injections_per_day?.reduce((a, b) => a + b, 0) ?? 0;

  return (
    <Card className="min-w-[220px] flex flex-col gap-1.5 px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-nano text-txt3 font-mono uppercase tracking-wider">
          <Icon name="Activity" className="w-3 h-3" />
          curator health
        </div>
        <CanaryPill status={d?.canary_status ?? "unknown"} />
      </div>
      <div className="flex items-end justify-between gap-2">
        <div className="flex flex-col">
          <div className="text-2xl font-semibold tabular-nums leading-none">
            {q.isLoading ? "—" : total}
          </div>
          <div className="text-nano text-txt3">
            injections last {d?.window_days ?? WINDOW_DAYS}d
          </div>
        </div>
        <Sparkline values={d?.injections_per_day ?? []} />
      </div>
      <div className="grid grid-cols-4 gap-1 text-nano font-mono">
        <div className="flex flex-col items-start">
          <span className="text-txt3">hit</span>
          <span className="tabular-nums text-emerald-300">
            {q.isLoading ? "—" : pct(d?.hit_rate ?? 0)}
          </span>
        </div>
        <div className="flex flex-col items-start">
          <span className="text-txt3">corr</span>
          <span className="tabular-nums text-rose-300">
            {q.isLoading ? "—" : pct(d?.correction_rate ?? 0)}
          </span>
        </div>
        <div className="flex flex-col items-start">
          <span className="text-txt3">slnc</span>
          <span className="tabular-nums text-txt2">
            {q.isLoading ? "—" : pct(d?.silence_rate ?? 0)}
          </span>
        </div>
        <div className="flex flex-col items-start">
          <span className="text-txt3">clk</span>
          <span className="tabular-nums text-brandSoft">
            {q.isLoading ? "—" : pct(d?.click_through_rate ?? 0)}
          </span>
        </div>
      </div>
      {d && d.flagged_pages_count > 0 && (
        <div className="text-nano text-amber-300">
          {d.flagged_pages_count} flagged for review
        </div>
      )}
    </Card>
  );
}
