"use client";

/**
 * KPI strip for the dashboard home.
 *
 * Today: one tile, the lines-of-code ticker that walks every
 * registered project's `git ls-files` and sums newline counts. The
 * server caches for 5 min; client polls every 60s. Animated count-up
 * on bump so brain growth is visible.
 *
 * Designed to grow into a multi-tile KPI row once the user picks
 * which numbers actually matter to him.
 */
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { statsLoc, type LocStats } from "@/lib/daemon-client";
import * as Lucide from "lucide-react";
import { Icon } from "./Icon";

type LucideIconName = keyof typeof Lucide;

function fmt(n: number): string {
  return n.toLocaleString();
}

/* Animated count-up. When target value bumps, tweens from previous
 * value over ~600ms with an ease-out curve so the number does not
 * jump. Tabular-nums on parent prevents per-digit layout shift. */
function useCountUp(target: number, durationMs = 600): number {
  const [display, setDisplay] = useState(target);
  const fromRef = useRef(target);
  const startRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  useEffect(() => {
    if (target === display) return;
    fromRef.current = display;
    startRef.current = performance.now();
    const tick = (now: number) => {
      const elapsed = now - (startRef.current ?? now);
      const t = Math.min(1, elapsed / durationMs);
      const eased = 1 - Math.pow(1 - t, 4);
      const value = Math.round(
        fromRef.current + (target - fromRef.current) * eased,
      );
      setDisplay(value);
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      }
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);
  return display;
}

interface KpiCardProps {
  icon: LucideIconName;
  label: string;
  value: number;
  sub?: string;
  loading?: boolean;
  pulse?: boolean;
}

function KpiCard({ icon, label, value, sub, loading, pulse }: KpiCardProps) {
  const display = useCountUp(loading ? 0 : value);
  const [highlight, setHighlight] = useState(false);
  const lastRef = useRef(value);
  useEffect(() => {
    if (!pulse) return;
    if (lastRef.current !== value) {
      lastRef.current = value;
      setHighlight(true);
      const t = setTimeout(() => setHighlight(false), 1200);
      return () => clearTimeout(t);
    }
  }, [value, pulse]);
  return (
    <div className="rounded-panel bg-surface1 hairline px-5 py-4 flex items-start gap-3 min-w-[220px] flex-1">
      <div
        className={`mt-0.5 ${
          highlight ? "text-promoted" : "text-brandSoft"
        } transition-colors`}
      >
        <Icon name={icon} size={18} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-nano text-txt3 font-mono uppercase tracking-wider">
          {label}
        </div>
        <div
          className={`text-3xl font-mono font-emphasized tabular-nums ${
            highlight ? "text-promoted" : "text-txt1"
          } transition-colors`}
        >
          {loading ? "—" : fmt(display)}
        </div>
        {sub && (
          <div className="text-nano text-txt3 mt-0.5 truncate" title={sub}>
            {sub}
          </div>
        )}
      </div>
    </div>
  );
}

export function KpiStrip() {
  const locQ = useQuery<LocStats>({
    queryKey: ["stats-loc"],
    queryFn: () => statsLoc(),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const total = locQ.data?.total ?? 0;
  const projectCount = locQ.data?.by_project.length ?? 0;
  const topProject = locQ.data?.by_project[0];
  const sub = topProject
    ? `across ${projectCount} projects · top: ${topProject.name} (${fmt(topProject.lines)})`
    : `across ${projectCount} projects`;

  return (
    <section className="flex gap-3 overflow-x-auto pb-1">
      <KpiCard
        icon="Code2"
        label="Lines of code"
        value={total}
        sub={sub}
        loading={locQ.isLoading}
        pulse
      />
    </section>
  );
}
