"use client";

/**
 * KPI strip for the dashboard home.
 *
 * Five rows, each one axis of "is the brain working":
 *   1. Size — lines of code, wiki pages, raw chunks, reference chunks
 *   2. Quality — wiki avg weight, hits/corrections last 7d, flagged, cross-project
 *   3. Activity — active CC sessions, brainstorms, artifacts
 *   4. Velocity — git commits last 7d
 *   5. Health — last backup, daemon uptime, embedder calls
 *
 * Two queries: /stats/loc (cached 5 min server-side, polled 60s) and
 * /stats/kpi (omnibus, polled 30s, heavy parts cached 60s server-
 * side). Animated count-up on every numeric change so brain growth
 * is visible without being noisy. Pulse highlight on tiles that
 * represent "more is good" growth signals (LOC, wiki, hits).
 */
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { statsLoc, statsKpi, type LocStats, type KpiStats } from "@/lib/daemon-client";
import * as Lucide from "lucide-react";
import { Icon } from "./Icon";

type LucideIconName = keyof typeof Lucide;

function fmt(n: number): string {
  return n.toLocaleString();
}

function fmtUptime(s: number): string {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

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
  value: number | string;
  sub?: string;
  loading?: boolean;
  pulse?: boolean;
  /* When the value is a string we skip the count-up tween. Used for
   * non-numeric tiles like "last backup: 2.1d ago". */
  raw?: boolean;
}

function KpiCard({ icon, label, value, sub, loading, pulse, raw }: KpiCardProps) {
  const numeric = typeof value === "number" ? value : 0;
  const display = useCountUp(loading ? 0 : numeric);
  const [highlight, setHighlight] = useState(false);
  const lastRef = useRef<number | string>(value);
  useEffect(() => {
    if (!pulse) return;
    if (lastRef.current !== value) {
      lastRef.current = value;
      setHighlight(true);
      const t = setTimeout(() => setHighlight(false), 1200);
      return () => clearTimeout(t);
    }
  }, [value, pulse]);
  const shown = loading
    ? "—"
    : raw
      ? String(value)
      : fmt(display);
  return (
    <div className="rounded-panel bg-surface1 hairline px-4 py-3 flex items-start gap-3 min-w-[180px] flex-1">
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
          className={`text-2xl font-mono font-emphasized tabular-nums ${
            highlight ? "text-promoted" : "text-txt1"
          } transition-colors`}
        >
          {shown}
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

function Row({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="text-nano text-txt3 font-mono uppercase tracking-wider px-1">
        {title}
      </div>
      <div className="flex gap-3 overflow-x-auto pb-1">{children}</div>
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
  const kpiQ = useQuery<KpiStats>({
    queryKey: ["stats-kpi"],
    queryFn: () => statsKpi(),
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  const loading = locQ.isLoading || kpiQ.isLoading;
  const k = kpiQ.data;

  /* Size row */
  const locTotal = locQ.data?.total ?? 0;
  const projectCount = locQ.data?.by_project.length ?? 0;
  const topProject = locQ.data?.by_project[0];
  const wikiPages =
    (k?.wiki?.canonical ?? 0) +
    (k?.wiki?.pending ?? 0) +
    (k?.wiki?.archived ?? 0);
  const wikiSub = k?.wiki
    ? `${k.wiki.canonical} canonical · ${k.wiki.pending} pending · ${k.wiki.archived} archived`
    : "";
  const rawChunks = k?.store?.raw_chunks ?? 0;
  const refChunks = k?.store?.reference_chunks ?? 0;

  /* Quality row */
  const avgWeight = k?.wiki?.avg_weight ?? null;
  const flagged = k?.wiki?.flagged_for_review ?? 0;
  const crossProj = k?.wiki?.cross_project ?? 0;
  const hits = k?.reinforcement?.hits_7d ?? 0;
  const corrections = k?.reinforcement?.corrections_7d ?? 0;

  /* Activity row */
  const ccActive = k?.sessions?.active ?? 0;
  const ccTotal = k?.sessions?.total ?? 0;
  const phases = k?.sessions?.by_phase ?? {};
  const phaseSub = Object.entries(phases)
    .filter(([, n]) => (n as number) > 0)
    .map(([p, n]) => `${n} ${p}`)
    .join(" · ");
  const bsActive = k?.brainstorm?.active ?? 0;
  const bsTotal = k?.brainstorm?.total ?? 0;
  const bsModes = k?.brainstorm?.by_mode ?? {};
  const bsSub = Object.entries(bsModes)
    .filter(([, n]) => (n as number) > 0)
    .map(([m, n]) => `${n} ${m}`)
    .join(" · ") || `${bsTotal} total`;
  const artifacts = k?.artifacts;
  const artifactSub = artifacts
    ? `${artifacts.research_notes} notes · ${artifacts.wiki_drafts} drafts · ${artifacts.notes_summaries} meetings`
    : "";

  /* Velocity row */
  const commits7d = k?.git?.commits_7d ?? 0;

  /* Health row */
  const backupAgo = k?.backup?.days_ago;
  const backupSub = k?.backup?.last_run_at
    ? `last ran ${new Date(k.backup.last_run_at).toLocaleString()}`
    : "no backup target configured";
  const backupValue: string =
    backupAgo === null || backupAgo === undefined
      ? "—"
      : backupAgo < 1
        ? `${Math.round(backupAgo * 24)}h ago`
        : `${backupAgo}d ago`;

  const uptime = k?.daemon?.uptime_s ?? 0;
  const embedCalls = k?.embedder?.embed_calls ?? 0;

  return (
    <section className="flex flex-col gap-4">
      <Row title="Size">
        <KpiCard
          icon="Code2"
          label="Lines of code"
          value={locTotal}
          sub={
            topProject
              ? `${projectCount} projects · top: ${topProject.name} (${fmt(topProject.lines)})`
              : `${projectCount} projects`
          }
          loading={locQ.isLoading}
          pulse
        />
        <KpiCard
          icon="BookOpen"
          label="Wiki pages"
          value={wikiPages}
          sub={wikiSub}
          loading={loading}
          pulse
        />
        <KpiCard
          icon="Database"
          label="Raw chunks"
          value={rawChunks}
          sub="vector store entries from transcripts"
          loading={loading}
        />
        <KpiCard
          icon="FileText"
          label="Reference chunks"
          value={refChunks}
          sub="uploaded PDFs / docs / audio"
          loading={loading}
        />
      </Row>

      <Row title="Quality">
        <KpiCard
          icon="Scale"
          label="Wiki avg weight"
          value={avgWeight !== null ? avgWeight.toFixed(2) : "—"}
          sub="0.00 (decay) — 1.00 (canonical promoted)"
          loading={loading}
          raw
        />
        <KpiCard
          icon="ThumbsUp"
          label="Hits last 7d"
          value={hits}
          sub={`${corrections} corrections in same window`}
          loading={loading}
          pulse
        />
        <KpiCard
          icon="Flag"
          label="Flagged for review"
          value={flagged}
          sub="pages awaiting your eyeball"
          loading={loading}
        />
        <KpiCard
          icon="Network"
          label="Cross-project pages"
          value={crossProj}
          sub="patterns proven across 2+ projects"
          loading={loading}
        />
      </Row>

      <Row title="Activity">
        <KpiCard
          icon="Activity"
          label="Active CC sessions"
          value={ccActive}
          sub={
            phaseSub
              ? `${phaseSub} · ${ccTotal} total`
              : `${ccTotal} total`
          }
          loading={loading}
          pulse
        />
        <KpiCard
          icon="MessageCircle"
          label="Active brainstorms"
          value={bsActive}
          sub={bsSub}
          loading={loading}
        />
        <KpiCard
          icon="Sparkles"
          label="Artifacts captured"
          value={artifacts?.total ?? 0}
          sub={artifactSub || "research-notes + wiki-drafts + notes-summaries + project-intents"}
          loading={loading}
        />
      </Row>

      <Row title="Velocity">
        <KpiCard
          icon="GitCommit"
          label="Commits last 7d"
          value={commits7d}
          sub="across every registered project"
          loading={loading}
          pulse
        />
      </Row>

      <Row title="Health">
        <KpiCard
          icon="Save"
          label="Last backup"
          value={backupValue}
          sub={backupSub}
          loading={loading}
          raw
        />
        <KpiCard
          icon="Clock"
          label="Daemon uptime"
          value={fmtUptime(uptime)}
          sub={`pid ${k?.daemon?.node_pid ?? "—"}`}
          loading={loading}
          raw
        />
        <KpiCard
          icon="Cpu"
          label="Embedder calls"
          value={embedCalls}
          sub={`${k?.embedder?.model ?? "—"} · ${k?.embedder?.dim ?? 0}-dim`}
          loading={loading}
        />
      </Row>
    </section>
  );
}
