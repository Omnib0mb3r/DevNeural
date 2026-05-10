"use client";

/**
 * Outbound KPI card (PB-3).
 *
 * Lives in the Health row of KpiStrip. Additive only: existing
 * Health tiles untouched. Polls /stats/outbound at the same 30s
 * cadence as the rest of the strip.
 *
 * Renders today's per-destination call counts, a cap-remaining
 * progress bar, and the "0 ever, by design" assertion for
 * brainstorm_outbound_count_alltime. Anything other than 0 on the
 * brainstorm assertion is treated as a critical bug and rendered
 * in rose.
 */
import { useQuery } from "@tanstack/react-query";
import { statsOutbound, type OutboundStats } from "@/lib/daemon-client";
import { Icon } from "../Icon";

function fmt(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString();
}

function fmtBytes(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function OutboundCard() {
  const q = useQuery<OutboundStats>({
    queryKey: ["stats-outbound"],
    queryFn: () => statsOutbound(),
    refetchInterval: 30_000,
    staleTime: 15_000,
    retry: 0,
  });
  const d = q.data;
  const today = d?.today;
  const cap = today?.cap ?? 0;
  const used = today ? today.calls_total : 0;
  const pct = cap > 0 ? Math.min(100, Math.round((used / cap) * 100)) : 0;
  const paused = today?.paused ?? false;
  const brainstormCount = d?.brainstorm_outbound_count_alltime ?? 0;
  const brainstormOk = brainstormCount === 0;

  return (
    <div className="min-w-[240px] flex flex-col gap-1.5 px-3 py-2.5 rounded-md bg-bg2 border border-bd2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-nano text-txt3 font-mono uppercase tracking-wider">
          <Icon name="ArrowUpRight" className="w-3 h-3" />
          outbound today
        </div>
        {paused && (
          <span className="text-nano px-1.5 py-0.5 rounded border border-rose-500/30 bg-rose-500/15 text-rose-300 font-mono uppercase tracking-wider">
            paused
          </span>
        )}
      </div>
      <div className="flex items-end justify-between gap-2">
        <div className="text-2xl font-semibold tabular-nums leading-none">
          {q.isLoading ? "—" : fmt(used)}
        </div>
        <div className="text-nano text-txt3">
          {fmt(cap - used)} / {fmt(cap)} left
        </div>
      </div>
      {/* Cap remaining bar. Width animates via CSS transition; no
        * extra deps. */}
      <div className="h-1.5 w-full bg-bd2/60 rounded-full overflow-hidden">
        <div
          className={`h-full transition-all duration-300 ${
            pct >= 100
              ? "bg-rose-500"
              : pct >= 80
                ? "bg-amber-500"
                : "bg-accent2"
          }`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="flex flex-col gap-0.5 text-nano font-mono">
        <div className="text-txt3">
          {fmtBytes(today?.bytes_total ?? 0)} bytes today
        </div>
        {today && Object.keys(today.calls_by_destination).length > 0 ? (
          Object.entries(today.calls_by_destination).map(([dest, n]) => (
            <div key={dest} className="flex justify-between text-txt2">
              <span className="truncate">{dest}</span>
              <span className="tabular-nums">{n}</span>
            </div>
          ))
        ) : (
          <div className="text-txt3">no destinations hit today</div>
        )}
      </div>
      <div
        className={`text-nano font-mono ${
          brainstormOk ? "text-emerald-300" : "text-rose-300"
        }`}
        title="Brainstorm content is forbidden in every outbound code path (PB-4 / BF-4)."
      >
        brainstorm outbound: {fmt(brainstormCount)} ever
        {brainstormOk ? ", by design" : " — INVARIANT VIOLATED"}
      </div>
    </div>
  );
}
