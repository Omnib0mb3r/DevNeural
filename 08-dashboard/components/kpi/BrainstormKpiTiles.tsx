"use client";

/**
 * Brainstorm KPI tiles (BF-12).
 *
 * Five tiles slot into the existing Activity row of KpiStrip.
 * Additive only: existing Activity tiles untouched. Polls
 * /stats/brainstorm-kpi at the same 30s cadence as the rest of
 * the strip.
 *
 * Tiles per spec section 4.1:
 *   - total_brainstorms
 *   - hours_captured
 *   - artifacts_per_brainstorm_avg
 *   - wiki_lineage_coverage  (fraction of derived_from_brainstorm pages
 *     with non-empty source_brainstorms; reported as a percentage)
 *   - project_less_ratio     (fraction of brainstorms with project_slug
 *     null = the 'general' namespace; reported as a percentage)
 *
 * Wave 1 backend returns 0 for artifacts_per_brainstorm_avg and
 * wiki_lineage_coverage until the artifacts join + source_brainstorms
 * lineage land in Wave 2; the tiles render those zeros honestly.
 */
import { useQuery } from "@tanstack/react-query";
import {
  statsBrainstormKpi,
  type BrainstormKpiStats,
} from "@/lib/daemon-client";
import { Icon } from "../Icon";

function fmt(n: number, digits = 0): string {
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function pct(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return `${Math.round(n * 100)}%`;
}

interface TileProps {
  icon: Parameters<typeof Icon>[0]["name"];
  label: string;
  value: string;
  sub: string;
  loading: boolean;
}

function Tile({ icon, label, value, sub, loading }: TileProps) {
  return (
    <div className="min-w-[148px] flex flex-col gap-1 px-3 py-2.5 rounded-md bg-bg2 border border-bd2">
      <div className="flex items-center gap-1.5 text-nano text-txt3 font-mono uppercase tracking-wider">
        <Icon name={icon} className="w-3 h-3" />
        {label}
      </div>
      <div className="text-2xl font-semibold tabular-nums leading-none">
        {loading ? "—" : value}
      </div>
      <div className="text-nano text-txt3">{sub}</div>
    </div>
  );
}

export function BrainstormKpiTiles() {
  const q = useQuery<BrainstormKpiStats>({
    queryKey: ["stats-brainstorm-kpi"],
    queryFn: () => statsBrainstormKpi(),
    refetchInterval: 30_000,
    staleTime: 15_000,
    retry: 0,
  });
  const d = q.data;
  const loading = q.isLoading;
  return (
    <>
      <Tile
        icon="MessageSquareMore"
        label="Brainstorms total"
        value={fmt(d?.total_brainstorms ?? 0)}
        sub={`${fmt(d?.active_today ?? 0)} active today`}
        loading={loading}
      />
      <Tile
        icon="Clock"
        label="Hours captured"
        value={fmt(d?.hours_captured ?? 0, 1)}
        sub="cumulative voice + notes"
        loading={loading}
      />
      <Tile
        icon="Sparkles"
        label="Artifacts / brainstorm"
        value={fmt(d?.artifacts_per_brainstorm_avg ?? 0, 1)}
        sub="avg across all brainstorms"
        loading={loading}
      />
      <Tile
        icon="GitBranch"
        label="Wiki lineage"
        value={pct(d?.wiki_lineage_coverage ?? 0)}
        sub="pages traceable to a brainstorm"
        loading={loading}
      />
      <Tile
        icon="Layers"
        label="Project-less"
        value={pct(d?.project_less_ratio ?? 0)}
        sub="general namespace share"
        loading={loading}
      />
    </>
  );
}
